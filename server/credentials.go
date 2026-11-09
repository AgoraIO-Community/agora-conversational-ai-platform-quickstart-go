package main

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const consoleRequired = "Set AGORA_CUSTOMER_ID and AGORA_CUSTOMER_SECRET to list, create, and switch Agora projects."

// ConsoleEnabled reports whether Console credentials are set, which enables the project picker.
func (s Settings) ConsoleEnabled() bool {
	return strings.TrimSpace(s.AgoraCustomerID) != "" && strings.TrimSpace(s.AgoraCustomerSecret) != ""
}

// certificateLookup returns a project's App Certificate by App ID ("" when it has none).
type certificateLookup func(appID string) (string, error)

// resolveAppCredentials picks the App ID and App Certificate that sign v3 requests.
// The configured project (AGORA_APP_ID) uses AGORA_APP_CERTIFICATE; a different
// project chosen in the picker uses its own certificate, fetched from Console.
func resolveAppCredentials(selectedAppID string, settings Settings, lookup certificateLookup) (string, string, error) {
	configured := strings.TrimSpace(settings.AgoraAppID)
	target := strings.TrimSpace(selectedAppID)
	if target == "" {
		target = configured
	}
	if target == "" {
		return "", "", configError{fmt.Errorf("Missing required environment variable: AGORA_APP_ID")}
	}
	if target == configured {
		certificate, err := require("AGORA_APP_CERTIFICATE", settings.AgoraAppCertificate)
		if err != nil {
			return "", "", configError{err}
		}
		return target, strings.TrimSpace(certificate), nil
	}
	certificate, err := lookup(target)
	if err != nil {
		return "", "", configError{err}
	}
	if strings.TrimSpace(certificate) == "" {
		return "", "", configError{fmt.Errorf("Project %s has no App Certificate. Enable the primary certificate in Agora Console.", target)}
	}
	return target, strings.TrimSpace(certificate), nil
}

// projectCertificate returns the sign_key of the project whose vendor_key matches appID.
func projectCertificate(data any, appID string) string {
	values, _ := jsonObject(data)["projects"].([]any)
	for _, value := range values {
		project, ok := value.(map[string]any)
		if !ok || project["vendor_key"] != appID {
			continue
		}
		certificate, _ := project["sign_key"].(string)
		return strings.TrimSpace(certificate)
	}
	return ""
}

const certificateTTL = 5 * time.Minute

type cachedCertificate struct {
	value   string
	expires time.Time
}

var (
	certificateMu    sync.Mutex
	certificateCache = map[string]cachedCertificate{}
)

// consoleCertificateLookup reads a picker-selected project's certificate from
// Console. The value is cached briefly and never returned to the browser.
func consoleCertificateLookup(settings Settings) certificateLookup {
	return func(appID string) (string, error) {
		certificateMu.Lock()
		cached, ok := certificateCache[appID]
		certificateMu.Unlock()
		if ok && time.Now().Before(cached.expires) {
			return cached.value, nil
		}
		result, err := studioRequest(settings, "/dev/v1/projects", http.MethodGet, nil)
		if err != nil {
			return "", fmt.Errorf("Could not load the App Certificate for project %s from Agora Console: %w", appID, err)
		}
		if !studioSucceeded(result) {
			return "", fmt.Errorf("Could not load the App Certificate for project %s from Agora Console (HTTP %d).", appID, result.Status)
		}
		certificate := projectCertificate(result.Data, appID)
		if certificate != "" {
			certificateMu.Lock()
			certificateCache[appID] = cachedCertificate{certificate, time.Now().Add(certificateTTL)}
			certificateMu.Unlock()
		}
		return certificate, nil
	}
}

// configuredProjects answers /api/projects when Console credentials are not
// set: the only project is AGORA_APP_ID and creating or switching is unavailable.
func configuredProjects(c *gin.Context, settings Settings) {
	appID := strings.TrimSpace(settings.AgoraAppID)
	switch c.Request.Method {
	case http.MethodGet:
		if appID == "" {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Missing required environment variable: AGORA_APP_ID"})
			return
		}
		project := SafeProject{ID: "configured", Name: "Configured project", AppID: appID, Status: 1}
		c.JSON(http.StatusOK, gin.H{"projects": []SafeProject{project}, "selectedAppId": appID, "consoleEnabled": false})
	case http.MethodPut:
		var body struct {
			AppID string `json:"appId"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.AppID) != appID || appID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": consoleRequired})
			return
		}
		c.JSON(http.StatusOK, gin.H{"selectedAppId": appID})
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": consoleRequired})
	}
}
