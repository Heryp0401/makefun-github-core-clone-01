// Command forge is the Go implementation of the GitHub-compatible git forge
// for the make.fun github-core-clone-01 competition: one process serving git
// smart HTTP, REST v3, GraphQL v4 and MCP from an in-memory store.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"forge/internal/git"
	"forge/internal/graphql"
	"forge/internal/mcp"
	"forge/internal/rest"
	"forge/internal/store"
	"forge/internal/util"
)

func main() {
	token := os.Getenv("MAKEFUN_SHOP_TOKEN")
	envURL := strings.TrimRight(os.Getenv("MAKEFUN_ENV_URL"), "/")
	if token == "" || envURL == "" {
		fmt.Fprintln(os.Stderr, "forge: MAKEFUN_SHOP_TOKEN and MAKEFUN_ENV_URL must be set")
		os.Exit(2)
	}
	s := store.NewStore(token)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		util.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	restH := rest.Handler(s)
	gqlH := graphql.Handler(s)
	mcpH := mcp.Handler(s)
	gitH := git.Handler(s)
	mux.HandleFunc("/api/v3/", func(w http.ResponseWriter, r *http.Request) {
		learnViewer(s, r.URL.Path)
		restH(w, r)
	})
	mux.HandleFunc("/api/graphql", func(w http.ResponseWriter, r *http.Request) {
		gqlH(w, r)
	})
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		mcpH(w, r)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, ".git/") {
			learnViewer(s, r.URL.Path)
			gitH(w, r)
			return
		}
		util.WriteErr(w, http.StatusNotFound, "not found")
	})

	handler := withRequestID(withAuth(mux, token))

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, "forge: listen:", err)
		os.Exit(1)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	srv := &http.Server{Handler: handler}
	go func() {
		_ = srv.Serve(ln)
	}()

	if err := register(envURL, port); err != nil {
		fmt.Fprintln(os.Stderr, "forge: register:", err)
		os.Exit(1)
	}
	pollDone(envURL)
	_ = srv.Close()
	os.Exit(0)
}

// learnViewer records the viewer login from the first owner segment seen in
// any request path (git and REST paths carry it; /user paths do not).
func learnViewer(s *store.Store, path string) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	var owner string
	if len(parts) >= 2 && strings.HasSuffix(parts[1], ".git") {
		owner = parts[0]
	} else if len(parts) >= 4 && parts[0] == "api" && parts[1] == "v3" && parts[2] == "repos" {
		owner = parts[3]
	}
	if owner != "" {
		s.LearnViewer(owner)
	}
}

// withRequestID stamps every reply with a non-empty X-GitHub-Request-Id.
func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-GitHub-Request-Id", util.NewRequestID())
		next.ServeHTTP(w, r)
	})
}

// withAuth rejects every request without the bearer token, except /healthz.
func withAuth(next http.Handler, token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+token {
			util.WriteErr(w, http.StatusUnauthorized, "Requires authentication")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// register posts our port to the suite, retrying until it answers.
func register(envURL string, port int) error {
	body, _ := json.Marshal(map[string]int{"port": port})
	var lastErr error
	for i := 0; i < 300; i++ {
		req, err := http.NewRequest(http.MethodPost, envURL+"/register", bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return nil
			}
			lastErr = fmt.Errorf("register status %s", resp.Status)
		} else {
			lastErr = err
		}
		time.Sleep(100 * time.Millisecond)
	}
	return lastErr
}

// pollDone long-polls the suite until it reports the trial finished.
func pollDone(envURL string) {
	for {
		resp, err := http.Get(envURL + "/done")
		if err == nil {
			var d struct {
				Done bool `json:"done"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&d)
			resp.Body.Close()
			if d.Done {
				return
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
}
