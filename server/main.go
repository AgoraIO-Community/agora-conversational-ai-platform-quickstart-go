package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type SafeProject struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	AppID   string `json:"appId"`
	Status  int    `json:"status"`
	Created any    `json:"created"`
}

func main() {
	root, _ := os.Getwd()
	settings := loadSettings(root)
	router := gin.New()
	router.HandleMethodNotAllowed = true
	router.Use(gin.Logger(), gin.Recovery())
	registerRoutes(router, settings, root)
	addr := ":" + env("PORT", "8000")
	log.Printf("Agora Studio API demo listening on %s", addr)
	if err := router.Run(addr); err != nil {
		log.Fatal(err)
	}
}

func registerRoutes(router *gin.Engine, settings Settings, root string) {
	router.GET("/api/health", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	router.GET("/api/session/me", func(c *gin.Context) {
		user, authenticated := currentUser(c, settings)
		if !authenticated {
			c.JSON(http.StatusOK, gin.H{"authenticated": false, "authMode": settings.AuthMode()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"authenticated": true, "authMode": settings.AuthMode(), "user": user})
	})
	projects := projectsHandler(settings)
	router.GET("/api/projects", projects)
	router.POST("/api/projects", projects)
	router.PUT("/api/projects", projects)
	router.GET("/api/auth/agora/start", func(c *gin.Context) {
		returnTo := safeReturnTo(c.Query("returnTo"))
		if settings.AuthMode() == "bypass" {
			c.Redirect(http.StatusTemporaryRedirect, settings.AppPublicURL+returnTo)
			return
		}
		state := uuid.NewString()
		target, err := authorizeURL(settings, state)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		setCookie(c, oauthStateCookie, state, 600, settings)
		c.Redirect(http.StatusTemporaryRedirect, target)
	})
	router.GET("/api/auth/agora/callback", func(c *gin.Context) {
		target := settings.AppPublicURL + "/"
		if settings.AuthMode() == "bypass" {
			c.Redirect(http.StatusTemporaryRedirect, target)
			return
		}
		if oauthError := c.Query("error"); oauthError != "" {
			c.Redirect(http.StatusTemporaryRedirect, target+"?authError="+url.QueryEscape(oauthError))
			return
		}
		code, state := c.Query("code"), c.Query("state")
		if code == "" || state == "" {
			c.Redirect(http.StatusTemporaryRedirect, target+"?authError=missing_params")
			return
		}
		cookie, err := c.Request.Cookie(oauthStateCookie)
		clearCookie(c, oauthStateCookie)
		if err != nil || cookie.Value != state {
			c.Redirect(http.StatusTemporaryRedirect, target+"?authError=state_mismatch")
			return
		}
		token, err := exchangeCode(settings, code)
		if err != nil {
			log.Printf("SSO callback: %v", err)
			c.Redirect(http.StatusTemporaryRedirect, target+"?authError=exchange_failed")
			return
		}
		user, err := fetchCustomer(settings, token)
		if err != nil {
			log.Printf("SSO callback: %v", err)
			c.Redirect(http.StatusTemporaryRedirect, target+"?authError=exchange_failed")
			return
		}
		signed, err := signSession(user, settings.SessionJWTSecret)
		if err != nil {
			c.Redirect(http.StatusTemporaryRedirect, target+"?authError=exchange_failed")
			return
		}
		setCookie(c, sessionCookie, signed, 86400, settings)
		c.Redirect(http.StatusTemporaryRedirect, target)
	})
	router.POST("/api/auth/agora/logout", func(c *gin.Context) {
		clearCookie(c, sessionCookie)
		clearCookie(c, projectCookie)
		redirect := settings.AppPublicURL + "/"
		if settings.AuthMode() != "bypass" {
			redirect = logoutURL(settings, redirect)
		}
		c.JSON(http.StatusOK, gin.H{"redirect": redirect})
	})
	router.GET("/api/auth/agora/logout", func(c *gin.Context) {
		clearCookie(c, sessionCookie)
		clearCookie(c, projectCookie)
		redirect := settings.AppPublicURL + "/"
		if settings.AuthMode() != "bypass" {
			redirect = logoutURL(settings, redirect)
		}
		c.Redirect(http.StatusTemporaryRedirect, redirect)
	})
	v3Routes := v3Handler(settings)
	for _, path := range []string{"/api/v3/:resource", "/api/v3/:resource/:id", "/api/v3/:resource/:id/:action"} {
		router.GET(path, v3Routes)
		router.POST(path, v3Routes)
		router.PATCH(path, v3Routes)
		router.DELETE(path, v3Routes)
	}
	router.POST("/api/call", callHandler(settings))
	router.GET("/api/call", func(c *gin.Context) {
		c.JSON(http.StatusMethodNotAllowed, gin.H{"error": "Method not allowed"})
	})
	router.NoMethod(func(c *gin.Context) {
		c.JSON(http.StatusMethodNotAllowed, gin.H{"error": "Method not allowed"})
	})
	dist := filepath.Join(root, "client", "dist")
	hasClient := false
	if info, err := os.Stat(dist); err == nil && info.IsDir() {
		hasClient = true
		router.Static("/assets", filepath.Join(dist, "assets"))
	}
	router.NoRoute(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			if strings.HasPrefix(c.Request.URL.Path, "/api/v3/") {
				c.JSON(http.StatusMethodNotAllowed, gin.H{"error": "Method not allowed"})
				return
			}
			if c.Request.Method == http.MethodGet {
				c.JSON(http.StatusMethodNotAllowed, gin.H{"error": "Method not allowed"})
				return
			}
			c.JSON(http.StatusNotFound, gin.H{"error": "Unknown API endpoint"})
			return
		}
		if hasClient && (c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead) {
			requested := strings.TrimPrefix(c.Request.URL.Path, "/")
			candidate := filepath.Join(dist, filepath.Clean(requested))
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				c.File(candidate)
				return
			}
			c.File(filepath.Join(dist, "index.html"))
			return
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "Not found"})
	})
}

func safeProject(value any) (SafeProject, bool) {
	object, ok := value.(map[string]any)
	if !ok {
		return SafeProject{}, false
	}
	id, idOK := object["id"].(string)
	name, nameOK := object["name"].(string)
	appID, appIDOK := object["vendor_key"].(string)
	if !idOK || !nameOK || !appIDOK || id == "" || name == "" || appID == "" {
		return SafeProject{}, false
	}
	status := 1
	if raw, ok := object["status"].(float64); ok && raw == 0 {
		status = 0
	}
	created := object["created"]
	if _, ok := created.(float64); !ok {
		created = nil
	}
	return SafeProject{
		ID: id, Name: name, AppID: appID, Status: status, Created: created,
	}, true
}

func fetchProjects(settings Settings) ([]SafeProject, StudioResult, error) {
	result, err := studioRequest(
		settings,
		"/dev/v1/projects",
		http.MethodGet,
		nil,
	)
	if err != nil || !studioSucceeded(result) {
		return nil, result, err
	}
	object := jsonObject(result.Data)
	values, _ := object["projects"].([]any)
	projects := make([]SafeProject, 0, len(values))
	for _, value := range values {
		if project, ok := safeProject(value); ok {
			projects = append(projects, project)
		}
	}
	return projects, result, nil
}

func projectsHandler(settings Settings) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, ok := currentUser(c, settings); !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not authenticated."})
			return
		}
		if !settings.ConsoleEnabled() {
			configuredProjects(c, settings)
			return
		}

		if c.Request.Method == http.MethodPost {
			var body map[string]any
			if err := c.ShouldBindJSON(&body); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Project name must contain 1 to 255 characters."})
				return
			}
			name, _ := body["name"].(string)
			name = strings.TrimSpace(name)
			if name == "" || len(name) > 255 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Project name must contain 1 to 255 characters."})
				return
			}
			payload, _ := json.Marshal(gin.H{"name": name, "enable_sign_key": true})
			result, err := studioRequest(settings, "/dev/v1/project", http.MethodPost, payload)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			if !studioSucceeded(result) {
				status := result.Status
				if result.OK {
					status = http.StatusBadGateway
				}
				message := errorMessage(result.Data)
				if message == "unknown" {
					message = "Could not create Agora project."
				}
				c.JSON(status, gin.H{"error": message})
				return
			}
			project, ok := safeProject(jsonObject(result.Data)["project"])
			if !ok {
				c.JSON(http.StatusBadGateway, gin.H{"error": "Agora did not return the created project."})
				return
			}
			if err := setProjectCookie(c, project.AppID, settings); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusOK, gin.H{"project": project, "selectedAppId": project.AppID})
			return
		}

		if c.Request.Method == http.MethodPut {
			var body map[string]any
			if err := c.ShouldBindJSON(&body); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "An App ID is required."})
				return
			}
			appID, _ := body["appId"].(string)
			appID = strings.TrimSpace(appID)
			if appID == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "An App ID is required."})
				return
			}
			projects, result, err := fetchProjects(settings)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			if !studioSucceeded(result) {
				status := result.Status
				if result.OK {
					status = http.StatusBadGateway
				}
				c.JSON(status, gin.H{"error": errorMessage(result.Data)})
				return
			}
			found := false
			for _, project := range projects {
				if project.AppID == appID {
					found = true
					break
				}
			}
			if !found {
				c.JSON(http.StatusNotFound, gin.H{"error": "Project does not belong to this Agora customer."})
				return
			}
			if err := setProjectCookie(c, appID, settings); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusOK, gin.H{"selectedAppId": appID})
			return
		}

		projects, result, err := fetchProjects(settings)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if !studioSucceeded(result) {
			status := result.Status
			if result.OK {
				status = http.StatusBadGateway
			}
			message := errorMessage(result.Data)
			if message == "unknown" {
				message = "Could not load Agora projects."
			}
			c.JSON(status, gin.H{"error": message})
			return
		}
		selected := selectedProjectAppID(c, settings)
		valid := false
		for _, project := range projects {
			if project.AppID == selected {
				valid = true
				break
			}
		}
		if !valid {
			if len(projects) > 0 {
				selected = projects[0].AppID
			} else {
				selected = ""
			}
		}
		if selected != "" {
			if err := setProjectCookie(c, selected, settings); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		}
		c.JSON(http.StatusOK, gin.H{"projects": projects, "selectedAppId": selected, "consoleEnabled": true})
	}
}

func safeReturnTo(value string) string {
	if value == "" || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") {
		return "/"
	}
	return value
}
