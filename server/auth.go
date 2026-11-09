package main

import (
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

const sessionCookie = "pstn_session"
const oauthStateCookie = "pstn_oauth_state"
const projectCookie = "pstn_project"

type SessionUser struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

var devUser = SessionUser{ID: "dev@local", Email: "dev@local", Name: "Local Dev"}

func signSession(user SessionUser, secret string) (string, error) {
	if len(secret) < 32 {
		return "", fmt.Errorf("SESSION_JWT_SECRET must contain at least 32 characters.")
	}
	now := time.Now()
	claims := jwt.MapClaims{"sub": user.ID, "email": user.Email, "name": user.Name, "iat": now.Unix(), "exp": now.Add(24 * time.Hour).Unix()}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
}

func verifySession(token, secret string) (SessionUser, bool) {
	if len(secret) < 32 {
		return SessionUser{}, false
	}
	parsed, err := jwt.Parse(token, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return []byte(secret), nil
	})
	if err != nil || !parsed.Valid {
		return SessionUser{}, false
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return SessionUser{}, false
	}
	sub, ok := claims["sub"].(string)
	if !ok || sub == "" {
		return SessionUser{}, false
	}
	return SessionUser{ID: sub, Email: claimString(claims, "email"), Name: claimString(claims, "name")}, true
}
func claimString(claims jwt.MapClaims, key string) string {
	value, _ := claims[key].(string)
	return value
}
func currentUser(c *gin.Context, settings Settings) (SessionUser, bool) {
	if settings.AuthMode() == "bypass" {
		return devUser, true
	}
	cookie, err := c.Request.Cookie(sessionCookie)
	if err != nil {
		return SessionUser{}, false
	}
	return verifySession(cookie.Value, settings.SessionJWTSecret)
}
func setCookie(c *gin.Context, name, value string, maxAge int, settings Settings) {
	http.SetCookie(c.Writer, &http.Cookie{Name: name, Value: value, MaxAge: maxAge, HttpOnly: true, Secure: settings.Production(), SameSite: http.SameSiteLaxMode, Path: "/"})
}
func clearCookie(c *gin.Context, name string) {
	http.SetCookie(c.Writer, &http.Cookie{Name: name, Value: "", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode, Path: "/"})
}

func projectCookieSecret(settings Settings) (string, error) {
	secret := settings.SessionJWTSecret
	if secret == "" {
		secret = settings.AgoraCustomerSecret
	}
	if secret == "" {
		return "", fmt.Errorf("SESSION_JWT_SECRET or AGORA_CUSTOMER_SECRET is required for project selection.")
	}
	return secret, nil
}

func signProjectSelection(appID string, settings Settings) (string, error) {
	secret, err := projectCookieSecret(settings)
	if err != nil {
		return "", err
	}
	now := time.Now()
	claims := jwt.MapClaims{
		"sub": appID, "scope": "agora-project",
		"iat": now.Unix(), "exp": now.Add(24 * time.Hour).Unix(),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
}

func selectedProjectAppID(c *gin.Context, settings Settings) string {
	cookie, err := c.Request.Cookie(projectCookie)
	if err != nil {
		return settings.AgoraAppID
	}
	secret, err := projectCookieSecret(settings)
	if err != nil {
		return settings.AgoraAppID
	}
	parsed, err := jwt.Parse(cookie.Value, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return []byte(secret), nil
	})
	if err != nil || !parsed.Valid {
		return settings.AgoraAppID
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok || claimString(claims, "scope") != "agora-project" {
		return settings.AgoraAppID
	}
	appID := claimString(claims, "sub")
	if appID == "" {
		return settings.AgoraAppID
	}
	return appID
}

func setProjectCookie(c *gin.Context, appID string, settings Settings) error {
	token, err := signProjectSelection(appID, settings)
	if err != nil {
		return err
	}
	setCookie(c, projectCookie, token, 86400, settings)
	return nil
}
