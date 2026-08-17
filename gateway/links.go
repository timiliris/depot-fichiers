package main

// Links: give one path to someone who has no account.
//
// Two directions, one mechanism. A "share" link hands out read access to a file
// or folder; a "drop" link accepts uploads into a folder without ever letting
// the holder see what is already there — which is the whole point of lending
// someone a place to put a video.
//
// The token is the credential, so it is 256 bits of randomness and it is checked
// on every request along with the expiry and the path. A link can never reach
// outside the path it was made for, and never outside the folder its author was
// confined to: a link cannot hand out more than the person who made it had.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type link struct {
	Token   string `json:"token"`
	Kind    string `json:"kind"` // "share" (read) or "drop" (write)
	Path    string `json:"path"`
	Owner   string `json:"owner"`
	Expires int64  `json:"expires,omitempty"` // unix seconds; 0 never expires
	Created int64  `json:"created"`
}

func (l *link) alive() bool { return l.Expires == 0 || time.Now().Unix() < l.Expires }

type linkStore struct {
	mu    sync.RWMutex
	path  string
	items []link
}

func newLinkStore(p string) (*linkStore, error) {
	if dir := filepath.Dir(p); dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, err
		}
	}
	s := &linkStore{path: p}
	raw, err := os.ReadFile(p)
	if err == nil {
		if err := json.Unmarshal(raw, &s.items); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return s, nil
}

func (s *linkStore) persist() error {
	body, err := json.MarshalIndent(s.items, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(body, '\n'), 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *linkStore) get(token string) *link {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range s.items {
		if s.items[i].Token == token {
			l := s.items[i]
			return &l
		}
	}
	return nil
}

func (s *linkStore) byOwner(owner string, all bool) []link {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []link{}
	for _, l := range s.items {
		if all || l.Owner == owner {
			out = append(out, l)
		}
	}
	return out
}

func (s *linkStore) add(l link) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items = append(s.items, l)
	return s.persist()
}

// drop removes a link, and prunes anything already expired while it is here.
func (s *linkStore) drop(token, owner string, admin bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().Unix()
	kept, found := s.items[:0], false
	for _, l := range s.items {
		if l.Token == token && (admin || l.Owner == owner) {
			found = true
			continue
		}
		if l.Expires != 0 && l.Expires < now {
			continue
		}
		kept = append(kept, l)
	}
	s.items = kept
	if !found {
		return errNotFound
	}
	return s.persist()
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

/* ── management, for signed-in accounts ───────────────────────────────── */

func (s *server) handleLinks(w http.ResponseWriter, r *http.Request) {
	me, ok := s.currentUser(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "session_expired"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		out := []map[string]any{}
		for _, l := range s.links.byOwner(me.Name, me.Admin) {
			out = append(out, map[string]any{
				"token": l.Token, "kind": l.Kind, "path": l.Path,
				"name": path.Base(l.Path), "owner": l.Owner, "expires": l.Expires,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"links": out})

	case http.MethodPost:
		if r.Header.Get("X-Depot") == "" {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "missing_header"})
			return
		}
		var body struct {
			Kind string `json:"kind"`
			Path string `json:"path"`
			Days int    `json:"days"`
		}
		if err := readJSON(w, r, &body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_request"})
			return
		}
		if body.Kind != "share" && body.Kind != "drop" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_request"})
			return
		}
		clean := path.Clean("/" + strings.TrimSuffix(body.Path, "/"))
		// A link can never hand out more than its author could reach.
		if !withinRoot(me, clean) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "outside_root"})
			return
		}
		token, err := newToken()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "server"})
			return
		}
		l := link{Token: token, Kind: body.Kind, Path: clean, Owner: me.Name, Created: time.Now().Unix()}
		if body.Days > 0 {
			l.Expires = time.Now().AddDate(0, 0, body.Days).Unix()
		}
		if body.Kind == "drop" {
			s.ensureUpstreamDir(strings.TrimPrefix(clean, "/"))
		}
		if err := s.links.add(l); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "server"})
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"token": l.Token, "kind": l.Kind, "expires": l.Expires})

	case http.MethodDelete:
		token := strings.TrimPrefix(r.URL.Path, "/api/links/")
		if token == "" || strings.Contains(token, "/") {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_request"})
			return
		}
		s.writeStoreResult(w, s.links.drop(token, me.Name, me.Admin))

	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method"})
	}
}

/* ── the public side: no session, only the token ──────────────────────── */

var errLinkGone = errors.New("link gone")

// resolveLink pulls the token out of the path and checks it is still good.
func (s *server) resolveLink(prefix string, r *http.Request) (*link, string, error) {
	rest := strings.TrimPrefix(r.URL.Path, prefix)
	token, tail, _ := strings.Cut(rest, "/")
	if token == "" {
		return nil, "", errLinkGone
	}
	l := s.links.get(token)
	if l == nil || !l.alive() {
		return nil, "", errLinkGone
	}
	return l, "/" + tail, nil
}

// handleLinkInfo tells the page what it is looking at. Deliberately thin: it
// never lists anything, so a drop link cannot be turned into a peek at the
// folder behind it.
func (s *server) handleLinkInfo(w http.ResponseWriter, r *http.Request) {
	l, _, err := s.resolveLink("/api/link/", r)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "link_gone"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"kind": l.Kind, "name": path.Base(l.Path), "expires": l.Expires,
		"title": s.cfg.Title, "lang": s.cfg.Lang,
	})
}

// handleLinkNotify is how a drop link says "that file is complete". Slices give
// the gateway no way to know it on its own, and the claim is checked against
// storage before the webhook goes out.
func (s *server) handleLinkNotify(w http.ResponseWriter, r *http.Request) {
	l, _, err := s.resolveLink("/api/linknotify/", r)
	if err != nil || l.Kind != "drop" {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "link_gone"})
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if err := readJSON(w, r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_request"})
		return
	}
	full := path.Join(l.Path, path.Clean("/"+body.Path))
	if full != l.Path && !strings.HasPrefix(full, l.Path+"/") {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "outside_root"})
		return
	}
	s.notifyUpload(full, "", path.Base(l.Path))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleLinkFS is the storage door for a link. What a kind may do is decided
// here and nowhere else.
func (s *server) handleLinkFS(w http.ResponseWriter, r *http.Request) {
	l, rest, err := s.resolveLink("/api/linkfs/", r)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "link_gone"})
		return
	}
	// The storage door is /fs/ and nothing else. Accepting any tail as a path
	// worked, but it meant a typo in a URL silently became a filename.
	if rest != "/fs" && !strings.HasPrefix(rest, "/fs/") {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "link_gone"})
		return
	}
	rest = strings.TrimPrefix(rest, "/fs")
	if rest == "" {
		rest = "/"
	}

	clean := path.Clean(rest)
	if !strings.HasPrefix(clean, "/") {
		clean = "/" + clean
	}
	full := path.Join(l.Path, clean)
	if strings.HasSuffix(rest, "/") && full != "/" {
		full += "/"
	}
	// Containment is checked on the joined path, so "../" in the tail cannot
	// walk out of what the link was made for.
	trimmed := strings.TrimSuffix(full, "/")
	if trimmed != l.Path && !strings.HasPrefix(trimmed, l.Path+"/") {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "outside_root"})
		return
	}

	switch l.Kind {
	case "share":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "read_only"})
			return
		}
	case "drop":
		// HEAD is allowed because resuming an upload needs the current size.
		// GET is not: a drop link must never become a way to read the folder.
		switch r.Method {
		case http.MethodPut, http.MethodPatch, "MKCOL", http.MethodHead:
		default:
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "write_only"})
			return
		}
	}

	r.URL.Path = full
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	s.proxy.ServeHTTP(w, r)
}
