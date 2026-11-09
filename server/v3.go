package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/AgoraIO/agora-agents-go/v2/agentkit"
	"github.com/AgoraIO/agora-agents-go/v2/core"
	"github.com/AgoraIO/agora-agents-go/v2/option"
	v3 "github.com/AgoraIO/agora-agents-go/v2/v3"
	"github.com/gin-gonic/gin"
)

// v3HTTPClient lets tests stub the SDK transport; nil uses the SDK default.
var v3HTTPClient core.HTTPClient

// routeError is a local response with a fixed status (validation, 404, 405).
type routeError struct {
	status  int
	message string
}

func (e *routeError) Error() string { return e.message }

var (
	errMethodNotAllowed = &routeError{http.StatusMethodNotAllowed, "Method not allowed"}
	errUnknownEndpoint  = &routeError{http.StatusNotFound, "Unknown API endpoint"}
	errMissingETag      = &routeError{http.StatusBadGateway, "Agora did not return an ETag for this resource."}
)

// configError marks missing server configuration; its message is safe to return.
type configError struct{ error }

// newV3Client builds an SDK low-level v3 client for the selected project. The SDK
// signs each request with a ConvoAI token generated from the App ID and App
// Certificate, and reads AGORA_AGENTS_V3_BASE_URL itself.
func newV3Client(c *gin.Context, settings Settings) (*v3.Client, error) {
	// The project picker needs Console credentials; without them, use AGORA_APP_ID.
	selected := ""
	if settings.ConsoleEnabled() {
		selected = selectedProjectAppID(c, settings)
	}
	appID, certificate, err := resolveAppCredentials(selected, settings, consoleCertificateLookup(settings))
	if err != nil {
		return nil, err
	}
	return agentkit.NewAgoraClient(agentkit.AgoraClientOptions{
		Area:           option.AreaUS,
		AppID:          appID,
		AppCertificate: certificate,
		HTTPClient:     v3HTTPClient,
	}).V3, nil
}

// writeV3Error maps SDK and local errors onto the shared quickstart error shape.
func writeV3Error(c *gin.Context, err error) {
	var local *routeError
	if errors.As(err, &local) {
		c.JSON(local.status, gin.H{"error": local.message})
		return
	}
	var config configError
	if errors.As(err, &config) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": config.Error()})
		return
	}
	// SDK errors are mapped by category (see the v3 package's Err* sentinels).
	var api *v3.APIError
	switch {
	case errors.As(err, &api):
		writeV3APIError(c, api)
	case errors.Is(err, v3.ErrValidation):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	case errors.Is(err, v3.ErrConfiguration):
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	case errors.Is(err, v3.ErrTimeout):
		c.JSON(http.StatusGatewayTimeout, gin.H{"error": "The Agora v3 API timed out."})
	case errors.Is(err, v3.ErrConnection):
		log.Printf("v3_connection_error error=%v", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "Could not reach the Agora v3 API."})
	default:
		log.Printf("v3_unexpected_error error=%v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Internal server error."})
	}
}

// writeV3APIError keeps the upstream status for error responses. A 2xx
// response that violates the API contract is the upstream's fault, so it is a
// 502 rather than a success status.
func writeV3APIError(c *gin.Context, api *v3.APIError) {
	var details any = api.ParsedBody
	if details == nil && len(api.Body) > 0 {
		details = string(api.Body)
	}
	body := gin.H{"reason": nilIfEmpty(api.Reason), "requestId": nilIfEmpty(api.RequestID), "details": details}
	if api.StatusCode < http.StatusBadRequest {
		body["error"] = "Agora returned an invalid response: " + api.Error()
		c.JSON(http.StatusBadGateway, body)
		return
	}
	switch {
	case api.Detail != "":
		body["error"] = api.Detail
	case api.Reason != "":
		body["error"] = api.Reason
	default:
		body["error"] = "Agora v3 request failed."
	}
	c.JSON(api.StatusCode, body)
}

func nilIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// decode parses a JSON object body strictly: unknown fields are rejected rather
// than silently dropped by the SDK's typed request structs.
func decode[T any](raw []byte) (T, error) {
	var value T
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, &routeError{http.StatusBadRequest, "Invalid JSON body: " + err.Error()}
	}
	if decoder.More() {
		return value, &routeError{http.StatusBadRequest, "Invalid JSON body: unexpected trailing data"}
	}
	return value, nil
}

// etag returns the ETag of a freshly read resource for a conditional write.
func etag[T any](response *v3.Response[T], err error) (string, error) {
	if err != nil {
		return "", err
	}
	if response.ETag == "" {
		return "", errMissingETag
	}
	return response.ETag, nil
}

func body[T any](response *v3.Response[T], err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return response.Body, nil
}

func listOptions(query url.Values) (v3.ListOptions, error) {
	limit, err := optionalInt64(query, "limit")
	if err != nil {
		return v3.ListOptions{}, err
	}
	options := v3.ListOptions{Cursor: query.Get("cursor"), Order: query.Get("order")}
	if limit != nil {
		options.Limit = int(*limit)
	}
	return options, nil
}

// optionalInt64 parses an optional integer query parameter; malformed values are a 400.
func optionalInt64(query url.Values, key string) (*int64, error) {
	value := query.Get(key)
	if value == "" {
		return nil, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return nil, &routeError{http.StatusBadRequest, "Query parameter " + key + " must be an integer."}
	}
	return &parsed, nil
}

func sessionListOptions(query url.Values) (v3.SessionListOptions, error) {
	base, err := listOptions(query)
	if err != nil {
		return v3.SessionListOptions{}, err
	}
	after, err := optionalInt64(query, "started_after")
	if err != nil {
		return v3.SessionListOptions{}, err
	}
	before, err := optionalInt64(query, "started_before")
	if err != nil {
		return v3.SessionListOptions{}, err
	}
	// Sessions do not support ordering.
	base.Order = ""
	return v3.SessionListOptions{ListOptions: base, Channel: query.Get("channel"), Status: query.Get("status"), StartedAfter: after, StartedBefore: before}, nil
}

// v3Dispatch is the route table: (resource, method, id, action) -> SDK call.
func v3Dispatch(ctx context.Context, api *v3.Client, method, resource, id, action string, query url.Values, raw []byte) (any, error) {
	if action != "" {
		switch {
		case resource == "sessions" && action == "stop":
			return body(api.Sessions.Stop(ctx, id))
		case resource == "campaigns" && action == "pause":
			return body(api.Campaigns.Pause(ctx, id))
		case resource == "campaigns" && action == "resume":
			return body(api.Campaigns.Resume(ctx, id))
		case resource == "campaigns" && action == "cancel":
			return body(api.Campaigns.Cancel(ctx, id))
		}
		return nil, errUnknownEndpoint
	}
	key := method
	if id != "" {
		key += " id"
	}
	switch resource + " " + key {
	case "agents GET":
		options, err := listOptions(query)
		if err != nil {
			return nil, err
		}
		return body(api.Agents.List(ctx, options))
	case "agents POST":
		input, err := decode[v3.AgentCreate](raw)
		if err != nil {
			return nil, err
		}
		return body(api.Agents.Create(ctx, input))
	case "agents GET id":
		return body(api.Agents.Get(ctx, id))
	case "agents PATCH id":
		patch, err := decode[v3.AgentPatch](raw)
		if err != nil {
			return nil, err
		}
		ifMatch, err := etag(api.Agents.Get(ctx, id))
		if err != nil {
			return nil, err
		}
		return body(api.Agents.Update(ctx, id, ifMatch, patch))
	case "agents DELETE id":
		return body(api.Agents.Delete(ctx, id))

	case "secrets GET":
		options, err := listOptions(query)
		if err != nil {
			return nil, err
		}
		return body(api.Secrets.List(ctx, options))
	case "secrets POST":
		input, err := decode[v3.SecretCreate](raw)
		if err != nil {
			return nil, err
		}
		return body(api.Secrets.Create(ctx, input, ""))
	case "secrets GET id":
		return body(api.Secrets.Get(ctx, id))
	case "secrets PATCH id":
		input, err := decode[v3.SecretUpdate](raw)
		if err != nil {
			return nil, err
		}
		return body(api.Secrets.Update(ctx, id, "", input))
	case "secrets DELETE id":
		ifMatch, err := etag(api.Secrets.Get(ctx, id))
		if err != nil {
			return nil, err
		}
		return body(api.Secrets.Delete(ctx, id, ifMatch))

	case "numbers GET":
		options, err := listOptions(query)
		if err != nil {
			return nil, err
		}
		return body(api.Numbers.List(ctx, options))
	case "numbers POST":
		input, err := decode[v3.NumberCreate](raw)
		if err != nil {
			return nil, err
		}
		return body(api.Numbers.Create(ctx, input, ""))
	case "numbers GET id":
		return body(api.Numbers.Get(ctx, id))
	case "numbers PATCH id":
		patch, err := decode[v3.NumberPatch](raw)
		if err != nil {
			return nil, err
		}
		ifMatch, err := etag(api.Numbers.Get(ctx, id))
		if err != nil {
			return nil, err
		}
		return body(api.Numbers.Update(ctx, id, ifMatch, patch))
	case "numbers DELETE id":
		return body(api.Numbers.Delete(ctx, id))

	case "campaigns GET":
		options, err := listOptions(query)
		if err != nil {
			return nil, err
		}
		return body(api.Campaigns.List(ctx, v3.CampaignListOptions{ListOptions: options, Status: query.Get("status")}))
	case "campaigns POST":
		input, err := decode[v3.CampaignCreate](raw)
		if err != nil {
			return nil, err
		}
		return body(api.Campaigns.Create(ctx, input))
	case "campaigns GET id":
		return body(api.Campaigns.Get(ctx, id))
	case "campaigns PATCH id":
		patch, err := decode[v3.CampaignPatch](raw)
		if err != nil {
			return nil, err
		}
		ifMatch, err := etag(api.Campaigns.Get(ctx, id))
		if err != nil {
			return nil, err
		}
		return body(api.Campaigns.Update(ctx, id, ifMatch, patch))
	case "campaigns DELETE id":
		return body(api.Campaigns.Delete(ctx, id))

	case "sessions GET":
		options, err := sessionListOptions(query)
		if err != nil {
			return nil, err
		}
		return body(api.Sessions.List(ctx, options))
	case "sessions GET id":
		return body(api.Sessions.Get(ctx, id))
	}
	return nil, errMethodNotAllowed
}

var v3Resources = map[string]bool{"agents": true, "secrets": true, "numbers": true, "campaigns": true, "sessions": true}

// v3RouteShapeError rejects disallowed method/path shapes before any credentials are needed.
func v3RouteShapeError(method, resource, action string) error {
	switch {
	case action != "" && method != http.MethodPost:
		return errMethodNotAllowed
	case action != "" && !(resource == "sessions" && action == "stop") &&
		!(resource == "campaigns" && (action == "pause" || action == "resume" || action == "cancel")):
		return errUnknownEndpoint
	case action == "" && resource == "sessions" && method != http.MethodGet:
		return errMethodNotAllowed // sessions start only through /api/call
	}
	return nil
}

func v3Handler(settings Settings) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, ok := currentUser(c, settings); !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not authenticated."})
			return
		}
		resource := c.Param("resource")
		if !v3Resources[resource] {
			c.JSON(http.StatusNotFound, gin.H{"error": "Unsupported v3 resource."})
			return
		}
		if err := v3RouteShapeError(c.Request.Method, resource, c.Param("action")); err != nil {
			writeV3Error(c, err)
			return
		}
		api, err := newV3Client(c, settings)
		if err != nil {
			writeV3Error(c, err)
			return
		}
		raw, _ := c.GetRawData()
		result, err := v3Dispatch(c.Request.Context(), api, c.Request.Method, resource, c.Param("id"), c.Param("action"), c.Request.URL.Query(), raw)
		if err != nil {
			writeV3Error(c, err)
			return
		}
		c.JSON(http.StatusOK, result)
	}
}

func callHandler(settings Settings) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, ok := currentUser(c, settings)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not authenticated."})
			return
		}
		var input struct {
			To            string `json:"to"`
			AgentID       string `json:"agentId"`
			PhoneNumberID string `json:"phoneNumberId"`
		}
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON body"})
			return
		}
		to, agentID, numberID := strings.TrimSpace(input.To), strings.TrimSpace(input.AgentID), strings.TrimSpace(input.PhoneNumberID)
		if !strings.HasPrefix(to, "+") || agentID == "" || numberID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Expected an E.164 to number, a v3 agentId, and a registered phoneNumberId."})
			return
		}
		log.Printf("v3_outbound_call_start agentId=%s phoneNumberId=%s userId=%s", agentID, numberID, user.ID)
		api, err := newV3Client(c, settings)
		if err != nil {
			writeV3Error(c, err)
			return
		}
		idleTimeout, maxDuration := 120_000, 300_000
		started, err := api.Sessions.Start(c.Request.Context(), v3.SessionStartRequest{
			AgentID:   agentID,
			Transport: v3.SessionTransport{Type: "telephony", From: numberID, To: to},
			Lifecycle: &v3.SessionLifecycle{IdleTimeoutMS: &idleTimeout, MaxDurationMS: &maxDuration},
			Labels:    map[string]string{"source": "quickstart", "agent_id": agentID},
		})
		if err != nil {
			log.Printf("v3_outbound_call_failed agentId=%s phoneNumberId=%s error=%v", agentID, numberID, err)
			writeV3Error(c, err)
			return
		}
		status := started.Body.Status
		if status == "" {
			status = "STARTING"
		}
		log.Printf("v3_outbound_call_ok agentId=%s agentSessionId=%s status=%s", agentID, started.Body.AgentSessionID, status)
		c.JSON(http.StatusOK, gin.H{"ok": true, "agentSessionId": started.Body.AgentSessionID, "status": status})
	}
}
