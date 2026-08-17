package main

// Account store and the endpoints that manage it.
//
// Accounts live in their own file rather than in config.json, for one reason:
// this is the only state the program rewrites at runtime. Keeping the operator
// settings — the signing secret above all — in a file it never writes means a
// bug in this path cannot destroy them. config.json still seeds the store the
// first time, so an existing install upgrades without doing anything.
//
// Each account carries an optional Root. Empty means the whole drop; set, the
// account is confined to that subfolder. Enforcement happens in the gateway, on
// every request, never in the browser.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

const minPasswordLen = 10

var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`)

var (
	errNotFound  = errors.New("no such account")
	errExists    = errors.New("account already exists")
	errLastAdmin = errors.New("this is the last administrator")
)

type store struct {
	mu    sync.RWMutex
	path  string
	users []user
}

func newStore(path string, seed []user) (*store, error) {
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("accounts directory: %w", err)
		}
	}
	s := &store{path: path}
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &s.users); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
	case os.IsNotExist(err):
		// First run: take whatever config.json declared, so nothing to migrate
		// by hand.
		s.users = append(s.users, seed...)
		if len(s.users) == 0 {
			return nil, errors.New("no account to seed from; declare users[] in the config")
		}
	default:
		return nil, err
	}
	// Normalise before writing anything, so the file on disk carries the same
	// values the process is using.
	seeded := len(raw) == 0
	for i := range s.users {
		if s.users[i].Ver == 0 {
			s.users[i].Ver = 1
			seeded = true
		}
	}
	if seeded {
		if err := s.persist(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// persist writes through a temporary file so an interrupted save cannot leave a
// truncated account list — which would lock everyone out.
func (s *store) persist() error {
	body, err := json.MarshalIndent(s.users, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(body, '\n'), 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *store) all() []user {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]user, len(s.users))
	copy(out, s.users)
	return out
}

func (s *store) find(name string) *user {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range s.users {
		if s.users[i].Name == name {
			u := s.users[i]
			return &u
		}
	}
	return nil
}

func (s *store) admins() int {
	n := 0
	for _, u := range s.users {
		if u.Admin {
			n++
		}
	}
	return n
}

func (s *store) create(u user) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.users {
		if strings.EqualFold(e.Name, u.Name) {
			return errExists
		}
	}
	u.Ver = 1
	s.users = append(s.users, u)
	return s.persist()
}

// update applies fn to the stored account. fn may refuse the change.
func (s *store) update(name string, fn func(*user) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.users {
		if s.users[i].Name != name {
			continue
		}
		before := s.users[i]
		if err := fn(&s.users[i]); err != nil {
			s.users[i] = before
			return err
		}
		// Never leave the install without a way back in.
		if before.Admin && !s.users[i].Admin && s.admins() == 0 {
			s.users[i] = before
			return errLastAdmin
		}
		return s.persist()
	}
	return errNotFound
}

func (s *store) remove(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.users {
		if s.users[i].Name != name {
			continue
		}
		if s.users[i].Admin && s.admins() == 1 {
			return errLastAdmin
		}
		s.users = append(s.users[:i], s.users[i+1:]...)
		return s.persist()
	}
	return errNotFound
}

/* ── validation ───────────────────────────────────────────────────── */

func validName(n string) error {
	if !nameRe.MatchString(n) {
		return errors.New("name: letters, digits, dot, dash or underscore, 1 to 32 characters")
	}
	return nil
}

func validPassword(p string) error {
	if utf8.RuneCountInString(p) < minPasswordLen {
		return fmt.Errorf("password: at least %d characters", minPasswordLen)
	}
	return nil
}

// cleanRoot normalises the confinement folder. The result never escapes the
// served tree, whatever was sent.
func cleanRoot(r string) string {
	r = strings.TrimSpace(r)
	if r == "" {
		return ""
	}
	r = path.Clean("/" + strings.ReplaceAll(r, "\\", "/"))
	return strings.Trim(r, "/")
}

/* ── endpoints ────────────────────────────────────────────────────── */

type userDTO struct {
	Name  string `json:"name"`
	Admin bool   `json:"admin"`
	Root  string `json:"root"`
	Self  bool   `json:"self,omitempty"`
}

func (s *server) requireAdmin(next func(http.ResponseWriter, *http.Request, *user)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := s.currentUser(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "session_expired"})
			return
		}
		if !u.Admin {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "not_admin"})
			return
		}
		if r.Method != http.MethodGet && r.Header.Get("X-Depot") == "" {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "missing_header"})
			return
		}
		next(w, r, u)
	}
}

func (s *server) handleUsers(w http.ResponseWriter, r *http.Request, me *user) {
	switch r.Method {
	case http.MethodGet:
		list := []userDTO{}
		for _, u := range s.users.all() {
			list = append(list, userDTO{Name: u.Name, Admin: u.Admin, Root: u.Root, Self: u.Name == me.Name})
		}
		writeJSON(w, http.StatusOK, map[string]any{"users": list})

	case http.MethodPost:
		var body struct {
			Name     string `json:"name"`
			Password string `json:"password"`
			Admin    bool   `json:"admin"`
			Root     string `json:"root"`
		}
		if err := readJSON(w, r, &body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_request"})
			return
		}
		if err := validName(body.Name); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_name", "detail": err.Error()})
			return
		}
		if err := validPassword(body.Password); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "weak_password", "detail": err.Error()})
			return
		}
		root := cleanRoot(body.Root)
		u := user{Name: body.Name, Hash: hashPassword(body.Password), Admin: body.Admin, Root: root}
		if err := s.users.create(u); err != nil {
			code := http.StatusBadRequest
			if errors.Is(err, errExists) {
				code = http.StatusConflict
			}
			writeJSON(w, code, map[string]any{"error": "exists"})
			return
		}
		// A confined account needs its folder to exist, or its first listing is
		// a 404 with nothing the guest can do about it.
		if root != "" {
			s.ensureUpstreamDir(root)
		}
		writeJSON(w, http.StatusCreated, map[string]any{"name": u.Name})

	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method"})
	}
}

func (s *server) handleUser(w http.ResponseWriter, r *http.Request, me *user) {
	name := strings.TrimPrefix(r.URL.Path, "/api/users/")
	if name == "" || strings.Contains(name, "/") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_request"})
		return
	}

	switch r.Method {
	case http.MethodPatch:
		var body struct {
			Password *string `json:"password"`
			Admin    *bool   `json:"admin"`
			Root     *string `json:"root"`
		}
		if err := readJSON(w, r, &body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_request"})
			return
		}
		if body.Password != nil {
			if err := validPassword(*body.Password); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "weak_password", "detail": err.Error()})
				return
			}
		}
		err := s.users.update(name, func(u *user) error {
			if body.Password != nil {
				u.Hash = hashPassword(*body.Password)
				u.Ver++ // drops every session that account had open
			}
			if body.Admin != nil {
				u.Admin = *body.Admin
			}
			if body.Root != nil {
				u.Root = cleanRoot(*body.Root)
				if u.Root != "" {
					s.ensureUpstreamDir(u.Root)
				}
			}
			return nil
		})
		s.writeStoreResult(w, err)

	case http.MethodDelete:
		if name == me.Name {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "not_yourself"})
			return
		}
		s.writeStoreResult(w, s.users.remove(name))

	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method"})
	}
}

// handlePassword lets an account change its own password, which keeps the owner
// from being the help desk for every guest.
func (s *server) handlePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method"})
		return
	}
	me, ok := s.currentUser(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "session_expired"})
		return
	}
	if r.Header.Get("X-Depot") == "" {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "missing_header"})
		return
	}
	var body struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if err := readJSON(w, r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_request"})
		return
	}
	// The throttle covers this too: it is a second door onto the same secret.
	ip := clientIP(r)
	if wait := s.throttle(ip); wait > 0 {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": "throttled", "retry_after": int(wait.Seconds()) + 1,
		})
		return
	}
	if !checkPassword(body.Current, me.Hash) {
		s.noteFailure(ip)
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "bad_credentials"})
		return
	}
	s.noteSuccess(ip)
	if err := validPassword(body.New); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "weak_password", "detail": err.Error()})
		return
	}
	err := s.users.update(me.Name, func(u *user) error {
		u.Hash = hashPassword(body.New)
		u.Ver++
		return nil
	})
	if err != nil {
		s.writeStoreResult(w, err)
		return
	}
	// The bumped version invalidated our own cookie as well; hand out a fresh
	// one so the person who just changed it is not thrown out.
	if u := s.users.find(me.Name); u != nil {
		s.setSession(w, r, u)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) writeStoreResult(w http.ResponseWriter, err error) {
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case errors.Is(err, errNotFound):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
	case errors.Is(err, errLastAdmin):
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "last_admin"})
	case errors.Is(err, errExists):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "exists"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "server"})
	}
}

// ensureUpstreamDir creates a folder through dufs rather than on a mounted path:
// the gateway only has the data folder read-only, and going through the storage
// keeps ownership consistent with every other write.
func (s *server) ensureUpstreamDir(rel string) {
	req, err := http.NewRequest("MKCOL", strings.TrimSuffix(s.cfg.Upstream, "/")+"/"+rel+"/", nil)
	if err != nil {
		return
	}
	if s.upstreamAuth != "" {
		req.Header.Set("Authorization", s.upstreamAuth)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("mkcol %s: %v", rel, err)
		return
	}
	resp.Body.Close()
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(v)
}
