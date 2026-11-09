package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func testRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	registerRoutes(router, Settings{AuthModeSetting: "bypass", AppPublicURL: "http://localhost:3000"}, ".")
	return router
}

func TestHealth(t *testing.T) {
	response := httptest.NewRecorder()
	testRouter().ServeHTTP(response, httptest.NewRequest("GET", "/api/health", nil))
	if response.Code != 200 || response.Body.String() != `{"status":"ok"}` {
		t.Fatalf("unexpected health response: %d %s", response.Code, response.Body.String())
	}
}

func TestBypassSession(t *testing.T) {
	response := httptest.NewRecorder()
	testRouter().ServeHTTP(response, httptest.NewRequest("GET", "/api/session/me", nil))
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"id":"dev@local"`) {
		t.Fatalf("unexpected session response: %d %s", response.Code, response.Body.String())
	}
}

func TestSafeProjectOmitsAppCertificate(t *testing.T) {
	project, ok := safeProject(map[string]any{
		"id": "project-id", "name": "Example customer",
		"vendor_key": "app-id", "sign_key": "server-only-certificate",
		"recording_server": "server-only", "status": float64(1),
		"created": float64(1700000000),
	})
	if !ok || project.ID != "project-id" || project.AppID != "app-id" {
		t.Fatalf("unexpected safe project: %#v", project)
	}
	encoded, _ := json.Marshal(project)
	if strings.Contains(string(encoded), "server-only") || strings.Contains(string(encoded), "sign_key") {
		t.Fatalf("safe project exposed server-only fields: %s", encoded)
	}
}

func TestProjectListAndCreateKeepCertificateServerSide(t *testing.T) {
	var createBody string
	original := studioHTTPClient
	studioHTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		project := `{"id":"project-id","name":"Example customer","vendor_key":"app-id","sign_key":"server-only-certificate","status":1,"created":1700000000}`
		body := `{"projects":[` + project + `]}`
		status := http.StatusOK
		if request.Method == http.MethodPost {
			raw, _ := io.ReadAll(request.Body)
			createBody = string(raw)
			body = `{"project":` + project + `}`
			status = http.StatusCreated
		}
		return &http.Response{
			StatusCode: status,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	})}
	defer func() { studioHTTPClient = original }()

	settings := Settings{
		AuthModeSetting: "bypass", AppPublicURL: "http://localhost:3000",
		AgoraAppID: "app-id", AgoraCustomerID: "customer",
		AgoraCustomerSecret: "cookie-secret",
		AgoraStudioAPIBase:  "https://api.invalid",
	}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	registerRoutes(router, settings, ".")

	listed := httptest.NewRecorder()
	router.ServeHTTP(listed, httptest.NewRequest(http.MethodGet, "/api/projects", nil))
	if listed.Code != http.StatusOK ||
		strings.Contains(listed.Body.String(), "server-only") ||
		!strings.Contains(listed.Header().Get("Set-Cookie"), projectCookie+"=") {
		t.Fatalf("unsafe project list response: %d %s", listed.Code, listed.Body.String())
	}

	created := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/projects",
		strings.NewReader(`{"name":"Example customer"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(created, request)
	if created.Code != http.StatusOK || strings.Contains(created.Body.String(), "server-only") {
		t.Fatalf("unsafe project create response: %d %s", created.Code, created.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(createBody), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["enable_sign_key"] != true || payload["name"] != "Example customer" {
		t.Fatalf("unexpected create payload: %#v", payload)
	}
}

func TestSharedRouteMethodContract(t *testing.T) {
	tests := []struct {
		method string
		path   string
		status int
		body   string
	}{
		{http.MethodGet, "/api/call", 405, `"error":"Method not allowed"`},
		{http.MethodPut, "/api/v3/agents", 405, `"error":"Method not allowed"`},
		{http.MethodDelete, "/api/v3/sessions/s1", 405, `"error":"Method not allowed"`},
		{http.MethodPost, "/api/v3/sessions", 405, `"error":"Method not allowed"`},
		{http.MethodGet, "/api/v3/calls", 404, `"error":"Unsupported v3 resource."`},
		{http.MethodGet, "/api/not-real", 405, `"error":"Method not allowed"`},
		{http.MethodPost, "/api/not-real", 404, `"error":"Unknown API endpoint"`},
	}
	for _, test := range tests {
		response := httptest.NewRecorder()
		testRouter().ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != test.status || !strings.Contains(response.Body.String(), test.body) {
			t.Errorf("%s %s: got %d %s", test.method, test.path, response.Code, response.Body.String())
		}
	}
}

func TestLogoutSupportsPostAndGet(t *testing.T) {
	for _, test := range []struct {
		method string
		status int
	}{
		{http.MethodPost, http.StatusOK},
		{http.MethodGet, http.StatusTemporaryRedirect},
	} {
		response := httptest.NewRecorder()
		testRouter().ServeHTTP(response, httptest.NewRequest(test.method, "/api/auth/agora/logout", nil))
		if response.Code != test.status {
			t.Errorf("%s logout returned %d", test.method, response.Code)
		}
	}
}

func TestStudioRequestSendsBasicAuthorization(t *testing.T) {
	var authorization string
	original := studioHTTPClient
	studioHTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		authorization = request.Header.Get("Authorization")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"code":0}`)),
		}, nil
	})}
	defer func() { studioHTTPClient = original }()

	_, err := studioRequest(Settings{
		AgoraStudioAPIBase:  "https://studio.invalid",
		AgoraCustomerID:     "customer",
		AgoraCustomerSecret: "secret",
	}, "/agents", http.MethodGet, nil)
	if err != nil {
		t.Fatal(err)
	}
	expected := "Basic " + base64.StdEncoding.EncodeToString([]byte("customer:secret"))
	if authorization != expected {
		t.Fatalf("expected authorization %q, got %q", expected, authorization)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
