package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/joho/godotenv"
)

type Settings struct {
	AppEnv, AuthModeSetting, AppPublicURL                                 string
	AllowBypassInProduction                                               bool
	AgoraAppID, AgoraAppCertificate, AgoraCustomerID, AgoraCustomerSecret string
	AgoraStudioAPIBase, SessionJWTSecret                                  string
	AgoraStudioDebug                                                      bool
	AgoraSSOClientID, AgoraSSOClientSecret, AgoraSSORedirectURI           string
	AgoraSSOBaseURL, AgoraSSOOpenAPIBase                                  string
}

func loadSettings(root string) Settings {
	_ = godotenv.Load(root + "/.env")
	return Settings{
		AppEnv: env("APP_ENV", "development"), AuthModeSetting: env("AUTH_MODE", ""),
		AppPublicURL:            strings.TrimRight(env("APP_PUBLIC_URL", "http://localhost:3000"), "/"),
		AllowBypassInProduction: strings.EqualFold(env("ALLOW_BYPASS_IN_PRODUCTION", ""), "true"),
		AgoraAppID:              env("AGORA_APP_ID", ""), AgoraAppCertificate: env("AGORA_APP_CERTIFICATE", ""), AgoraCustomerID: env("AGORA_CUSTOMER_ID", ""), AgoraCustomerSecret: env("AGORA_CUSTOMER_SECRET", ""),
		AgoraStudioAPIBase: strings.TrimRight(env("AGORA_STUDIO_API_BASE", "https://api.agora.io"), "/"), AgoraStudioDebug: strings.EqualFold(env("AGORA_STUDIO_DEBUG", ""), "true"),
		SessionJWTSecret: env("SESSION_JWT_SECRET", ""), AgoraSSOClientID: env("AGORA_SSO_CLIENT_ID", ""), AgoraSSOClientSecret: env("AGORA_SSO_CLIENT_SECRET", ""),
		AgoraSSORedirectURI: env("AGORA_SSO_REDIRECT_URI", ""), AgoraSSOBaseURL: strings.TrimRight(env("AGORA_SSO_BASE_URL", "https://sso2.agora.io"), "/"), AgoraSSOOpenAPIBase: strings.TrimRight(env("AGORA_SSO_OPEN_API_BASE", "https://sso-open.agora.io/api-docs/v1"), "/"),
	}
}

func env(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok {
		return strings.TrimSpace(value)
	}
	return fallback
}
func (s Settings) Production() bool { return strings.EqualFold(s.AppEnv, "production") }
func (s Settings) AuthMode() string {
	mode := s.AuthModeSetting
	if mode == "" {
		if s.Production() {
			mode = "sso"
		} else {
			mode = "bypass"
		}
	}
	if strings.EqualFold(mode, "bypass") && s.Production() && !s.AllowBypassInProduction {
		return "sso"
	}
	if strings.EqualFold(mode, "bypass") {
		return "bypass"
	}
	return "sso"
}
func require(name, value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("Missing required environment variable: %s", name)
	}
	return value, nil
}
