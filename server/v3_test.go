package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// Token generation requires 32-character App IDs and certificates.
const (
	testAppID          = "0123456789abcdef0123456789abcdef"
	testAppCertificate = "fedcba9876543210fedcba9876543210"
)

type recordedRequest struct {
	Method, Path, Query, Authorization, IfMatch, Body string
}

// stubV3 routes SDK traffic to handler and records every request.
func stubV3(t *testing.T, handler func(r *http.Request) (int, http.Header, string)) (*gin.Engine, *[]recordedRequest) {
	t.Helper()
	var requests []recordedRequest
	v3HTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		raw := ""
		if r.Body != nil {
			b, _ := io.ReadAll(r.Body)
			raw = string(b)
		}
		requests = append(requests, recordedRequest{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), r.Header.Get("If-Match"), raw})
		status, header, body := handler(r)
		if header == nil {
			header = http.Header{}
		}
		header.Set("Content-Type", "application/json")
		return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	t.Cleanup(func() { v3HTTPClient = nil })
	t.Setenv("AGORA_AGENTS_V3_BASE_URL", "https://v3.invalid")
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.HandleMethodNotAllowed = true
	registerRoutes(router, Settings{
		AuthModeSetting: "bypass", AppPublicURL: "http://localhost:3000",
		AgoraAppID: testAppID, AgoraAppCertificate: testAppCertificate,
	}, ".")
	return router, &requests
}

func serve(router *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	router.ServeHTTP(response, request)
	return response
}

func TestV3ListUsesSDKWithAppCredentialsAndQuery(t *testing.T) {
	router, requests := stubV3(t, func(*http.Request) (int, http.Header, string) {
		return 200, nil, `{"data":{"count":1,"list":[{"agent_id":"a1","agent_name":"Support"}]},"has_more":false,"next_cursor":null}`
	})
	response := serve(router, http.MethodGet, "/api/v3/agents?limit=5&order=create_ts.desc&ignored=x", "")
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"agent_id":"a1"`) {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
	got := (*requests)[0]
	if got.Path != "/conversational-ai/v1/projects/"+testAppID+"/agents" || strings.Contains(got.Query, "ignored") || !strings.Contains(got.Query, "limit=5") {
		t.Fatalf("unexpected upstream request: %#v", got)
	}
	if !strings.HasPrefix(got.Authorization, "agora token=007") {
		t.Fatalf("unexpected authorization %q", got.Authorization)
	}
}

func TestV3PatchReadsETagThenWrites(t *testing.T) {
	router, requests := stubV3(t, func(r *http.Request) (int, http.Header, string) {
		return 200, http.Header{"Etag": []string{`"v1"`}}, `{"agent_id":"a1","agent_name":"Support"}`
	})
	response := serve(router, http.MethodPatch, "/api/v3/agents/a1", `{"instructions":"Be brief."}`)
	if response.Code != 200 || len(*requests) != 2 {
		t.Fatalf("unexpected response: %d %s %#v", response.Code, response.Body.String(), *requests)
	}
	if (*requests)[0].Method != http.MethodGet || (*requests)[1].Method != http.MethodPatch || (*requests)[1].IfMatch != `"v1"` {
		t.Fatalf("expected GET then PATCH with If-Match: %#v", *requests)
	}
}

func TestV3UpstreamErrorMapping(t *testing.T) {
	router, _ := stubV3(t, func(*http.Request) (int, http.Header, string) {
		return 404, http.Header{"Agora-Request-Id": []string{"req-1"}}, `{"detail":"Agent not found","reason":"NOT_FOUND"}`
	})
	response := serve(router, http.MethodGet, "/api/v3/agents/missing", "")
	var payload map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &payload)
	if response.Code != 404 || payload["error"] != "Agent not found" || payload["reason"] != "NOT_FOUND" || payload["requestId"] != "req-1" || payload["details"] == nil {
		t.Fatalf("unexpected error mapping: %d %s", response.Code, response.Body.String())
	}
}

func TestV3CampaignActionAndSessionStop(t *testing.T) {
	router, requests := stubV3(t, func(*http.Request) (int, http.Header, string) { return 200, nil, `{}` })
	if response := serve(router, http.MethodPost, "/api/v3/campaigns/c1/pause", ""); response.Code != 200 {
		t.Fatalf("pause: %d %s", response.Code, response.Body.String())
	}
	if response := serve(router, http.MethodPost, "/api/v3/sessions/s1/stop", ""); response.Code != 200 {
		t.Fatalf("stop: %d %s", response.Code, response.Body.String())
	}
	if response := serve(router, http.MethodPost, "/api/v3/agents/a1/pause", ""); response.Code != 404 {
		t.Fatalf("unknown action: %d %s", response.Code, response.Body.String())
	}
	if (*requests)[0].Path != "/conversational-ai/v1/projects/"+testAppID+"/campaigns/c1:pause" || (*requests)[1].Path != "/conversational-ai/v1/projects/"+testAppID+"/sessions/s1/stop" {
		t.Fatalf("unexpected upstream paths: %#v", *requests)
	}
}

func TestCallValidationAndSessionStart(t *testing.T) {
	router, requests := stubV3(t, func(*http.Request) (int, http.Header, string) {
		return 200, nil, `{"agent_session_id":"s1","status":"STARTING","create_ts":1}`
	})
	if response := serve(router, http.MethodPost, "/api/call", `{"to":"12025550123","agentId":"a1","phoneNumberId":"n1"}`); response.Code != 400 {
		t.Fatalf("expected validation error, got %d", response.Code)
	}
	response := serve(router, http.MethodPost, "/api/call", `{"to":"+12025550123","agentId":"a1","phoneNumberId":"n1"}`)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"agentSessionId":"s1"`) {
		t.Fatalf("unexpected call response: %d %s", response.Code, response.Body.String())
	}
	var sent map[string]any
	_ = json.Unmarshal([]byte((*requests)[0].Body), &sent)
	transport := jsonObject(sent["transport"])
	if sent["agent_id"] != "a1" || transport["type"] != "telephony" || transport["from"] != "n1" || transport["to"] != "+12025550123" {
		t.Fatalf("unexpected session start body: %s", (*requests)[0].Body)
	}
}

func TestV3RejectsMalformedInputLocally(t *testing.T) {
	router, requests := stubV3(t, func(*http.Request) (int, http.Header, string) { return 200, nil, `{}` })
	cases := []struct{ method, path, body string }{
		{http.MethodGet, "/api/v3/agents?limit=ten", ""},
		{http.MethodGet, "/api/v3/sessions?started_after=yesterday", ""},
		{http.MethodPost, "/api/v3/agents", `{"agent_name":"Support","appid":"other"}`},
		{http.MethodPost, "/api/v3/numbers", `{"number":"+12025550123","sip_trunk":{"hostname":"sip.example.com"}} {}`},
	}
	for _, tc := range cases {
		if response := serve(router, tc.method, tc.path, tc.body); response.Code != http.StatusBadRequest {
			t.Errorf("%s %s: got %d %s, want 400", tc.method, tc.path, response.Code, response.Body.String())
		}
	}
	if len(*requests) != 0 {
		t.Fatalf("malformed input reached the upstream API: %#v", *requests)
	}
}

func TestV3MissingETagIsBadGateway(t *testing.T) {
	router, requests := stubV3(t, func(*http.Request) (int, http.Header, string) { return 200, nil, `{"agent_id":"a1"}` })
	response := serve(router, http.MethodPatch, "/api/v3/agents/a1", `{"instructions":"Be brief."}`)
	if response.Code != http.StatusBadGateway || len(*requests) != 1 {
		t.Fatalf("got %d %s after %d requests, want 502 after the GET only", response.Code, response.Body.String(), len(*requests))
	}
}

func TestV3TransportFailureIsBadGateway(t *testing.T) {
	router, _ := stubV3(t, nil)
	v3HTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection refused")
	})}
	response := serve(router, http.MethodGet, "/api/v3/agents", "")
	if response.Code != http.StatusBadGateway || !strings.Contains(response.Body.String(), "Could not reach") {
		t.Fatalf("got %d %s, want 502", response.Code, response.Body.String())
	}
}

func TestV3SDKValidationErrorIsBadRequest(t *testing.T) {
	router, requests := stubV3(t, func(*http.Request) (int, http.Header, string) { return 200, nil, `{}` })
	response := serve(router, http.MethodPost, "/api/v3/secrets", `{"name":"bad-name","secrets":{"k":"v"}}`)
	if response.Code != http.StatusBadRequest || len(*requests) != 0 {
		t.Fatalf("got %d %s after %d requests, want 400 before any request", response.Code, response.Body.String(), len(*requests))
	}
}

func TestV3ContractViolationIsBadGateway(t *testing.T) {
	router, _ := stubV3(t, func(*http.Request) (int, http.Header, string) {
		return 200, http.Header{"Agora-Request-Id": []string{"req-2"}}, `<html>`
	})
	response := serve(router, http.MethodGet, "/api/v3/agents/a1", "")
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != http.StatusBadGateway || body["requestId"] != "req-2" || !strings.Contains(body["error"].(string), "invalid response") {
		t.Fatalf("got %d %s, want 502 with the request ID", response.Code, response.Body.String())
	}
}
