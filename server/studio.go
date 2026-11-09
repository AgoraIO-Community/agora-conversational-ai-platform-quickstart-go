package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"github.com/google/uuid"
	"io"
	"log"
	"net/http"
	"time"
)

// studioRequest calls the Agora console projects API (/dev/v1), which the v3 SDK does not cover.
type StudioResult struct {
	OK     bool
	Status int
	Data   any
}

var studioHTTPClient = &http.Client{Timeout: 30 * time.Second}

func studioAuth(settings Settings) (string, error) {
	id, err := require("AGORA_CUSTOMER_ID", settings.AgoraCustomerID)
	if err != nil {
		return "", err
	}
	secret, err := require("AGORA_CUSTOMER_SECRET", settings.AgoraCustomerSecret)
	if err != nil {
		return "", err
	}
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(id+":"+secret)), nil
}
func studioRequest(settings Settings, path, method string, body []byte) (StudioResult, error) {
	auth, err := studioAuth(settings)
	if err != nil {
		return StudioResult{}, err
	}
	requestID := uuid.NewString()
	request, err := http.NewRequest(method, settings.AgoraStudioAPIBase+path, bytes.NewReader(body))
	if err != nil {
		return StudioResult{}, err
	}
	request.Header.Set("Authorization", auth)
	request.Header.Set("Accept", "application/json")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	if settings.AgoraStudioDebug || !settings.Production() {
		log.Printf("request %s method=%s url=%s", requestID, method, request.URL.String())
	}
	response, err := studioHTTPClient.Do(request)
	if err != nil {
		return StudioResult{}, err
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		return StudioResult{}, readErr
	}
	var data any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &data); err != nil {
			data = map[string]any{"message": string(raw)}
		}
	}
	if settings.AgoraStudioDebug || !settings.Production() {
		log.Printf("response %s status=%d", requestID, response.StatusCode)
	}
	return StudioResult{OK: response.StatusCode >= 200 && response.StatusCode < 300, Status: response.StatusCode, Data: data}, nil
}
func studioSucceeded(result StudioResult) bool {
	if !result.OK {
		return false
	}
	object, ok := result.Data.(map[string]any)
	if !ok {
		return true
	}
	code, ok := object["code"].(float64)
	return !ok || code == 0
}
func errorMessage(value any) string {
	object, ok := value.(map[string]any)
	if !ok {
		return "unknown"
	}
	for _, key := range []string{"error", "message", "detail", "reason"} {
		if message, ok := object[key].(string); ok && message != "" {
			return message
		}
	}
	return "unknown"
}
func jsonObject(value any) map[string]any { object, _ := value.(map[string]any); return object }
