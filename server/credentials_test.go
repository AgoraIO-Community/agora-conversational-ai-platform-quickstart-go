package main

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func unusedLookup(string) (string, error) { return "", errors.New("Console lookup should not run") }

func TestConfiguredProjectUsesEnvCertificate(t *testing.T) {
	settings := Settings{AgoraAppID: " app ", AgoraAppCertificate: " cert "}
	appID, certificate, err := resolveAppCredentials("", settings, unusedLookup)
	if err != nil || appID != "app" || certificate != "cert" {
		t.Fatalf("got %q %q %v", appID, certificate, err)
	}
}

func TestMissingAppCredentialsAreConfigErrors(t *testing.T) {
	cases := map[string]Settings{
		"AGORA_APP_ID":          {AgoraAppCertificate: "cert"},
		"AGORA_APP_CERTIFICATE": {AgoraAppID: "app"},
	}
	for name, settings := range cases {
		_, _, err := resolveAppCredentials("", settings, unusedLookup)
		var config configError
		if !errors.As(err, &config) || !strings.Contains(err.Error(), name) {
			t.Fatalf("%s: got %v", name, err)
		}
	}
}

func TestPickerProjectUsesConsoleCertificate(t *testing.T) {
	settings := Settings{AgoraAppID: "app", AgoraAppCertificate: "cert"}
	appID, certificate, err := resolveAppCredentials("other", settings, func(id string) (string, error) {
		if id != "other" {
			t.Fatalf("looked up %q", id)
		}
		return "other-cert", nil
	})
	if err != nil || appID != "other" || certificate != "other-cert" {
		t.Fatalf("got %q %q %v", appID, certificate, err)
	}
	_, _, err = resolveAppCredentials("other", settings, func(string) (string, error) { return "", nil })
	var config configError
	if !errors.As(err, &config) || !strings.Contains(err.Error(), "other") {
		t.Fatalf("got %v", err)
	}
}

func TestConsoleCertificateLookupReadsSignKey(t *testing.T) {
	original := studioHTTPClient
	calls := 0
	studioHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		body := `{"projects":[{"id":"p","name":"n","vendor_key":"lookup-app","sign_key":"lookup-cert"}]}`
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	defer func() { studioHTTPClient = original }()
	lookup := consoleCertificateLookup(Settings{AgoraCustomerID: "c", AgoraCustomerSecret: "s", AgoraStudioAPIBase: "https://api.invalid"})
	for i := 0; i < 2; i++ {
		if got, err := lookup("lookup-app"); err != nil || got != "lookup-cert" {
			t.Fatalf("got %q %v", got, err)
		}
	}
	if calls != 1 {
		t.Fatalf("expected one cached Console call, got %d", calls)
	}
	if got, err := lookup("missing-app"); err != nil || got != "" {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestProjectsWithoutConsoleExposeOnlyConfiguredProject(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	registerRoutes(router, Settings{AuthModeSetting: "bypass", AppPublicURL: "http://localhost:3000", AgoraAppID: "app", AgoraAppCertificate: "cert"}, ".")

	listed := serve(router, http.MethodGet, "/api/projects", "")
	body := listed.Body.String()
	if listed.Code != 200 || !strings.Contains(body, `"consoleEnabled":false`) || !strings.Contains(body, `"selectedAppId":"app"`) || strings.Contains(body, "cert") {
		t.Fatalf("unexpected list: %d %s", listed.Code, body)
	}
	if got := serve(router, http.MethodPut, "/api/projects", `{"appId":"app"}`); got.Code != 200 {
		t.Fatalf("select configured: %d %s", got.Code, got.Body.String())
	}
	for _, request := range []struct{ method, body string }{
		{http.MethodPut, `{"appId":"other"}`},
		{http.MethodPost, `{"name":"Example customer"}`},
	} {
		got := serve(router, request.method, "/api/projects", request.body)
		if got.Code != 400 || !strings.Contains(got.Body.String(), "AGORA_CUSTOMER_ID") {
			t.Fatalf("%s: %d %s", request.method, got.Code, got.Body.String())
		}
	}
}
