package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func authorizeURL(settings Settings, state string) (string, error) {
	client, err := require("AGORA_SSO_CLIENT_ID", settings.AgoraSSOClientID)
	if err != nil {
		return "", err
	}
	redirect, err := require("AGORA_SSO_REDIRECT_URI", settings.AgoraSSORedirectURI)
	if err != nil {
		return "", err
	}
	values := url.Values{"response_type": {"code"}, "client_id": {client}, "redirect_uri": {redirect}, "scope": {"basic_info"}, "state": {state}}
	return settings.AgoraSSOBaseURL + "/api/v0/oauth/authorize?" + values.Encode(), nil
}
func logoutURL(settings Settings, redirect string) string {
	return settings.AgoraSSOBaseURL + "/api/v0/logout?" + url.Values{"redirect_uri": {redirect}}.Encode()
}

func exchangeCode(settings Settings, code string) (string, error) {
	client, err := require("AGORA_SSO_CLIENT_ID", settings.AgoraSSOClientID)
	if err != nil {
		return "", err
	}
	secret, err := require("AGORA_SSO_CLIENT_SECRET", settings.AgoraSSOClientSecret)
	if err != nil {
		return "", err
	}
	redirect, err := require("AGORA_SSO_REDIRECT_URI", settings.AgoraSSORedirectURI)
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {client}, "client_secret": {secret}, "code": {code}, "redirect_uri": {redirect}}
	request, err := http.NewRequest(http.MethodPost, settings.AgoraSSOBaseURL+"/api/v0/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := (&http.Client{Timeout: 20 * time.Second}).Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("SSO token exchange returned %s", response.Status)
	}
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return "", err
	}
	token, _ := payload["access_token"].(string)
	if token == "" {
		return "", fmt.Errorf("Agora SSO token response did not include an access token.")
	}
	return token, nil
}

func fetchCustomer(settings Settings, accessToken string) (SessionUser, error) {
	origin := settings.AgoraSSOOpenAPIBase
	if parsed, err := url.Parse(origin); err == nil {
		origin = parsed.Scheme + "://" + parsed.Host
	}
	candidates := []string{origin + "/api/v0/customer/user-auth", origin + "/api/v0/customer/company/basic-info"}
	last := "unknown"
	client := &http.Client{Timeout: 20 * time.Second}
	for _, endpoint := range candidates {
		request, err := http.NewRequest(http.MethodGet, endpoint, nil)
		if err != nil {
			last = err.Error()
			continue
		}
		request.Header.Set("Authorization", "Bearer "+accessToken)
		request.Header.Set("Accept", "application/json")
		response, err := client.Do(request)
		if err != nil {
			last = err.Error()
			continue
		}
		var payload any
		decodeErr := json.NewDecoder(response.Body).Decode(&payload)
		response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 || decodeErr != nil {
			last = endpoint + " returned " + response.Status
			continue
		}
		data := payloadMap(payload)
		if data == nil {
			last = endpoint + " returned an invalid profile"
			continue
		}
		user, err := normalizeCustomer(data)
		if err == nil {
			return user, nil
		}
		last = err.Error()
	}
	return SessionUser{}, fmt.Errorf("Failed to fetch Agora customer profile: %s", last)
}
func payloadMap(value any) map[string]any {
	root, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	for _, key := range []string{"data", "customer"} {
		if nested, ok := root[key].(map[string]any); ok {
			return nested
		}
	}
	return root
}
func pick(data map[string]any, keys ...string) string {
	for _, key := range keys {
		switch value := data[key].(type) {
		case string:
			if strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		case float64:
			return fmt.Sprintf("%v", value)
		}
	}
	return ""
}
func normalizeCustomer(data map[string]any) (SessionUser, error) {
	id := pick(data, "customerId", "customer_id", "userId", "user_id", "id", "uid", "accountId", "account_id", "email", "emailAddress", "email_address", "loginEmail")
	if id == "" {
		return SessionUser{}, fmt.Errorf("Agora customer response did not include a stable user identifier.")
	}
	email := pick(data, "email", "emailAddress", "email_address", "loginEmail")
	name := pick(data, "name", "displayName", "display_name", "nickname", "fullName", "full_name", "username")
	if name == "" {
		name = email
		if name == "" {
			name = id
		}
	}
	return SessionUser{ID: id, Email: email, Name: name}, nil
}
