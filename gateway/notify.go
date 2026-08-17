package main

// Upload notification.
//
// The gateway sees slices, not files: a 12GB video arrives as one PUT and four
// hundred PATCHes, and nothing in that stream says "this was the last one". So
// the browser tells us when it is done and we verify the claim against storage
// before believing it — a client cannot invent a file that is not there.
//
// One POST to a URL from the config. No SMTP, no queue, no dependency: whoever
// runs this already has something that turns a webhook into a notification.

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"path"
	"strconv"
	"time"
)

type uploadEvent struct {
	Event string `json:"event"`
	Path  string `json:"path"`
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	User  string `json:"user"`
	Link  string `json:"link,omitempty"`
	At    string `json:"at"`
}

func (s *server) handleNotify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method"})
		return
	}
	me, _ := s.currentUser(r)
	var body struct {
		Path string `json:"path"`
	}
	if err := readJSON(w, r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_request"})
		return
	}
	clean := path.Clean("/" + body.Path)
	if !withinRoot(me, clean) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "outside_root"})
		return
	}
	s.notifyUpload(clean, me.Name, "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// notifyUpload confirms the file exists upstream, then fires the webhook without
// making anyone wait for it.
func (s *server) notifyUpload(fullPath, user, link string) {
	if s.cfg.WebhookURL == "" {
		return
	}
	go func() {
		size, ok := s.upstreamSize(fullPath)
		if !ok {
			return // nothing there: not an upload worth announcing
		}
		payload, err := json.Marshal(uploadEvent{
			Event: "upload", Path: fullPath, Name: path.Base(fullPath),
			Size: size, User: user, Link: link, At: time.Now().Format(time.RFC3339),
		})
		if err != nil {
			return
		}
		req, err := http.NewRequest(http.MethodPost, s.cfg.WebhookURL, bytes.NewReader(payload))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			log.Printf("webhook: %v", err)
			return
		}
		resp.Body.Close()
	}()
}

func (s *server) upstreamSize(p string) (int64, bool) {
	req, err := http.NewRequest(http.MethodHead, s.upstreamURL(p), nil)
	if err != nil {
		return 0, false
	}
	if s.upstreamAuth != "" {
		req.Header.Set("Authorization", s.upstreamAuth)
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return 0, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, false
	}
	n, _ := strconv.ParseInt(resp.Header.Get("Content-Length"), 10, 64)
	return n, true
}
