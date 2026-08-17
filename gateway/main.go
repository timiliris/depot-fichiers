// depot-gw puts authentication in front of a dufs file server.
//
// dufs only speaks HTTP Basic, which forces the browser's own credential
// dialog and leaves no room for a real sign-in page. This process owns the
// session instead: it serves the interface, checks a form login against
// PBKDF2 hashes, hands out a signed cookie, and relays every storage call to
// dufs over an internal network. dufs has no accounts of its own and is never
// published, so the cookie is the only way in — which also means downloads
// and video streaming authenticate themselves, something a header cannot do
// from a plain <a> or <video>.
//
// No external modules: everything is standard library, so the image builds
// without fetching anything.
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type user struct {
	Name  string `json:"name"`
	Hash  string `json:"hash"`
	Admin bool   `json:"admin,omitempty"`
	// Root confines the account to a subfolder of the served tree. Empty means
	// the whole drop, so a household can mix confined and unconfined accounts.
	Root string `json:"root,omitempty"`
	// Ver is bumped whenever the password changes; it rides inside the signed
	// cookie so a password change drops every session that account had open.
	Ver int `json:"ver,omitempty"`
}

type config struct {
	Listen   string `json:"listen"`
	Upstream string `json:"upstream"`
	// UpstreamAuth is "user:password" when dufs keeps accounts of its own. Leave
	// it empty when dufs runs open on a private network; either way the browser
	// never sees a WWW-Authenticate, which is this program's whole point.
	UpstreamAuth string `json:"upstream_auth"`
	QuotaPath    string `json:"quota_path"`
	SessionTTL   int    `json:"session_ttl_hours"`
	Secret       string `json:"secret"`
	Title        string `json:"title"`
	// Lang pins the interface language ("en" or "fr"). Empty lets each browser
	// pick from its own Accept-Language.
	Lang string `json:"lang"`
	// ClientIPHeader names the header the throttle should believe, e.g.
	// "CF-Connecting-IP". Only set it when a proxy you control *overwrites* that
	// header, because whatever it names is then taken at face value. Left empty,
	// the last X-Forwarded-For entry is used — the one appended by the nearest
	// proxy, and so the only one a client cannot choose.
	ClientIPHeader string `json:"client_ip_header"`
	Users          []user `json:"users"`
	// UsersFile holds the mutable account list, and defaults next to this file.
	// Accounts live apart from the operator settings because they are the only
	// state the program rewrites: a bug there cannot take the secret with it.
	UsersFile string `json:"users_file"`
}

type server struct {
	cfg          config
	secret       []byte
	proxy        *httputil.ReverseProxy
	web          fs.FS
	users        *store
	upstreamAuth string

	mu       sync.Mutex
	attempts map[string]*attempt // login throttle, keyed by client IP
}

type attempt struct {
	count int
	until time.Time
}

func main() {
	hashPw := flag.String("hash", "", "print the PBKDF2 hash of this password and exit")
	cfgPath := flag.String("config", "/etc/depot-gw/config.json", "path to the configuration file")
	flag.Parse()

	if *hashPw != "" {
		fmt.Println(hashPassword(*hashPw))
		return
	}

	raw, err := os.ReadFile(*cfgPath)
	if err != nil {
		log.Fatalf("read config: %v", err)
	}
	var cfg config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		log.Fatalf("parse config: %v", err)
	}
	if cfg.Listen == "" {
		cfg.Listen = ":5100"
	}
	if cfg.SessionTTL == 0 {
		cfg.SessionTTL = 24 * 30
	}
	if cfg.Title == "" {
		cfg.Title = "Drop"
	}
	if len(cfg.Secret) < 32 {
		log.Fatal("config: secret must be at least 32 characters")
	}
	// The example secret ships in this repository: anyone who forgets it lets
	// anybody forge a valid session cookie. It is long enough, so the check
	// above does not catch it.
	if strings.Contains(cfg.Secret, "REPLACE") {
		log.Fatal("config: replace the example secret — openssl rand -base64 48")
	}
	if len(cfg.Users) == 0 {
		log.Fatal("config: no users defined")
	}

	up, err := url.Parse(cfg.Upstream)
	if err != nil {
		log.Fatalf("parse upstream: %v", err)
	}

	// Deliberately NOT next to config.json: that path is a read-only mount of a
	// single file, so the accounts would land in the container layer and vanish
	// on the next rebuild — silently, which is the worst way to lose them.
	if cfg.UsersFile == "" {
		cfg.UsersFile = "/var/lib/depot-gw/users.json"
	}
	users, err := newStore(cfg.UsersFile, cfg.Users)
	if err != nil {
		log.Fatalf("accounts: %v", err)
	}

	srv := &server{
		cfg:      cfg,
		secret:   []byte(cfg.Secret),
		web:      webFS(),
		users:    users,
		attempts: map[string]*attempt{},
	}
	if cfg.UpstreamAuth != "" {
		srv.upstreamAuth = "Basic " + base64.StdEncoding.EncodeToString([]byte(cfg.UpstreamAuth))
	}
	upstreamAuth := srv.upstreamAuth

	srv.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(up)
			r.Out.Host = up.Host
			// Our cookie means nothing upstream, and the client never gets to
			// pick the identity used against the storage.
			r.Out.Header.Del("Cookie")
			r.Out.Header.Del("Authorization")
			if upstreamAuth != "" {
				r.Out.Header.Set("Authorization", upstreamAuth)
			}
		},
		// Frequent flushing: when the browser seeks inside a video the response
		// streams out instead of landing in one lump at the end.
		FlushInterval: 200 * time.Millisecond,
		ModifyResponse: func(resp *http.Response) error {
			// dufs redirects a directory written without its trailing slash. That
			// Location is expressed in the upstream's own space, so passing it
			// through unchanged would send the browser outside /api/fs.
			if loc := resp.Header.Get("Location"); loc != "" {
				if u, err := url.Parse(loc); err == nil && !strings.HasPrefix(u.Path, "/api/fs") {
					u.Scheme, u.Host = "", ""
					u.Path = "/api/fs" + u.Path
					resp.Header.Set("Location", u.String())
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("proxy %s %s: %v", r.Method, r.URL.Path, err)
			http.Error(w, "storage unreachable", http.StatusBadGateway)
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/login", srv.handleLogin)
	mux.HandleFunc("/api/logout", srv.handleLogout)
	mux.HandleFunc("/api/session", srv.handleSession)
	mux.HandleFunc("/api/quota", srv.requireAuth(srv.handleQuota))
	mux.HandleFunc("/api/password", srv.handlePassword)
	mux.HandleFunc("/api/users", srv.requireAdmin(srv.handleUsers))
	mux.HandleFunc("/api/users/", srv.requireAdmin(srv.handleUser))
	mux.HandleFunc("/api/fs/", srv.requireAuth(srv.handleFS))
	mux.HandleFunc("/", srv.handleStatic)

	// No read or write timeout: a single upload slice can legitimately take
	// minutes on a slow line, and a stalled connection is already cut further
	// up by the reverse proxy.
	httpSrv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           srv.logRequests(mux),
		ReadHeaderTimeout: 20 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("depot-gw listening on %s, storage %s, accounts %s",
		cfg.Listen, cfg.Upstream, cfg.UsersFile)
	log.Fatal(httpSrv.ListenAndServe())
}

// --- authentification ---------------------------------------------------

const (
	cookieName = "depot_session"
	pbkdf2Iter = 210_000
)

func hashPassword(pw string) string {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		log.Fatalf("rand: %v", err)
	}
	dk := pbkdf2SHA256([]byte(pw), salt, pbkdf2Iter, 32)
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", pbkdf2Iter,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(dk))
}

func checkPassword(pw, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1000 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	got := pbkdf2SHA256([]byte(pw), salt, iter, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	var out []byte
	for block := 1; len(out) < keyLen; block++ {
		mac := hmac.New(sha256.New, password)
		mac.Write(salt)
		var counter [4]byte
		binary.BigEndian.PutUint32(counter[:], uint32(block))
		mac.Write(counter[:])
		u := mac.Sum(nil)
		t := make([]byte, len(u))
		copy(t, u)
		for i := 1; i < iter; i++ {
			mac.Reset()
			mac.Write(u)
			u = mac.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

func (s *server) sign(name string, ver int, exp int64) string {
	payload := name + "." + strconv.Itoa(ver) + "." + strconv.FormatInt(exp, 10)
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *server) verify(token string) (*user, bool) {
	i := strings.LastIndex(token, ".")
	if i < 0 {
		return nil, false
	}
	payload, sig := token[:i], token[i+1:]
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payload))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(sig), []byte(want)) != 1 {
		return nil, false
	}
	parts := strings.Split(payload, ".")
	if len(parts) != 3 {
		return nil, false
	}
	exp, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return nil, false
	}
	ver, err := strconv.Atoi(parts[1])
	if err != nil {
		return nil, false
	}
	u := s.users.find(parts[0])
	// A deleted account, or one whose password has moved on, cannot ride an old
	// cookie back in.
	if u == nil || u.Ver != ver {
		return nil, false
	}
	return u, true
}

func (s *server) findUser(name string) *user { return s.users.find(name) }

// setSession issues the cookie. Kept in one place so its flags cannot drift
// between signing in and changing a password.
func (s *server) setSession(w http.ResponseWriter, r *http.Request, u *user) {
	exp := time.Now().Add(time.Duration(s.cfg.SessionTTL) * time.Hour)
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    s.sign(u.Name, u.Ver, exp.Unix()),
		Path:     "/",
		Expires:  exp,
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *server) clientIP(r *http.Request) string {
	if h := s.cfg.ClientIPHeader; h != "" {
		if v := r.Header.Get(h); v != "" {
			// A configured header is trusted, so its first value is the client.
			if i := strings.IndexByte(v, ','); i > 0 {
				return strings.TrimSpace(v[:i])
			}
			return strings.TrimSpace(v)
		}
	}
	// Otherwise the LAST X-Forwarded-For entry: a proxy appends the peer it
	// actually saw, so earlier entries are whatever the client cared to invent.
	// Reading the first one instead would let anyone dodge the throttle by
	// changing a header between attempts.
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.LastIndexByte(v, ','); i >= 0 {
			return strings.TrimSpace(v[i+1:])
		}
		return strings.TrimSpace(v)
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// throttle slows a password guesser to a crawl. The service is exposed on the
// internet, and the neighbouring SFTP port already shows what unattended
// scanning looks like.
func (s *server) throttle(ip string) time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.attempts[ip]
	if a == nil {
		return 0
	}
	if d := time.Until(a.until); d > 0 {
		return d
	}
	return 0
}

// maxTracked caps the throttle table. Without it, a run through a wide range of
// addresses grows the map for as long as the process lives.
const maxTracked = 4096

func (s *server) noteFailure(ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.attempts) >= maxTracked {
		// Drop entries whose lockout has run out; if none have, drop anything, as
		// forgetting a counter is far better than growing without bound.
		now := time.Now()
		for k, v := range s.attempts {
			if now.After(v.until) {
				delete(s.attempts, k)
			}
		}
		for k := range s.attempts {
			if len(s.attempts) < maxTracked {
				break
			}
			delete(s.attempts, k)
		}
	}
	a := s.attempts[ip]
	// Once a lockout has run its course, start counting from scratch.
	if a == nil || (a.count >= 5 && time.Now().After(a.until)) {
		a = &attempt{}
		s.attempts[ip] = a
	}
	a.count++
	if a.count >= 5 {
		// 5 wrong tries buy a minute, then two, then four, capped at 32.
		back := time.Duration(1<<min(a.count-5, 5)) * time.Minute
		a.until = time.Now().Add(back)
	}
}

func (s *server) noteSuccess(ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.attempts, ip)
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ip := s.clientIP(r)
	if wait := s.throttle(ip); wait > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": "throttled", "retry_after": int(wait.Seconds()) + 1,
		})
		return
	}
	var body struct {
		User     string `json:"user"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		http.Error(w, "unreadable request", http.StatusBadRequest)
		return
	}
	u := s.findUser(body.User)
	// Hash even for an unknown account, so a missing username and a wrong
	// password take the same time to answer.
	ref := "pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	encoded := ref
	if u != nil {
		encoded = u.Hash
	}
	if !checkPassword(body.Password, encoded) || u == nil {
		s.noteFailure(ip)
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "bad_credentials"})
		return
	}
	s.noteSuccess(ip)
	s.setSession(w, r, u)
	writeJSON(w, http.StatusOK, map[string]any{
		"user": u.Name, "admin": u.Admin, "root": u.Root,
	})
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) handleSession(w http.ResponseWriter, r *http.Request) {
	u, ok := s.currentUser(r)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{
			"authenticated": false, "title": s.cfg.Title, "lang": s.cfg.Lang,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true, "user": u.Name, "admin": u.Admin, "root": u.Root,
		"title": s.cfg.Title, "lang": s.cfg.Lang,
	})
}

func (s *server) currentUser(r *http.Request) (*user, bool) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return nil, false
	}
	return s.verify(c.Value)
}

func (s *server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := s.currentUser(r); !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "session_expired"})
			return
		}
		next(w, r)
	}
}

func isHTTPS(r *http.Request) bool {
	return r.TLS != nil ||
		strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") ||
		r.Header.Get("CF-Visitor") == `{"scheme":"https"}`
}

// --- stockage -----------------------------------------------------------

var allowedMethods = map[string]bool{
	http.MethodGet: true, http.MethodHead: true, http.MethodPut: true,
	http.MethodPatch: true, http.MethodDelete: true, "MKCOL": true, "MOVE": true,
}

// withinRoot reports whether a cleaned path stays inside the account's folder.
// An account with no Root sees the whole drop.
func withinRoot(u *user, clean string) bool {
	if u == nil {
		return false
	}
	if u.Root == "" {
		return true
	}
	base := "/" + u.Root
	trimmed := strings.TrimSuffix(clean, "/")
	if trimmed == "" {
		trimmed = "/"
	}
	return trimmed == base || strings.HasPrefix(trimmed, base+"/")
}

func (s *server) handleFS(w http.ResponseWriter, r *http.Request) {
	if !allowedMethods[r.Method] {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Anything that changes the tree must come from our own code. A cross-site
	// form cannot set a custom header, and SameSite=Lax already withholds the
	// cookie on a cross-site POST.
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if r.Header.Get("X-Depot") == "" {
			http.Error(w, "missing X-Depot header", http.StatusForbidden)
			return
		}
	}

	rest := strings.TrimPrefix(r.URL.Path, "/api/fs")
	if rest == "" {
		rest = "/"
	}
	// path.Clean collapses any ".." before dufs ever sees it.
	clean := path.Clean(rest)
	if !strings.HasPrefix(clean, "/") {
		clean = "/" + clean
	}
	if strings.HasSuffix(rest, "/") && clean != "/" {
		clean += "/"
	}

	// A confined account is held to its folder here, on every single request.
	// The browser is told where its root is, but it is never trusted about it:
	// otherwise the confinement would come off by typing a URL by hand.
	me, _ := s.currentUser(r) // requireAuth already vouched for the session
	if !withinRoot(me, clean) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "outside_root"})
		return
	}
	r.URL.Path = clean

	// A stored file is served from this very origin, so anything scriptable that
	// someone uploads would run with the session of whoever opens it — a guest
	// could hand the administrator a link and walk off with their cookie.
	// `sandbox` drops the response into an opaque origin with scripting off,
	// while still letting <img>, <video> and <audio> use it as a subresource.
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	// MOVE carries a Destination pointing back at us; rewrite it into the
	// upstream's space or dufs rejects it as a foreign host.
	if dest := r.Header.Get("Destination"); dest != "" {
		if u, err := url.Parse(dest); err == nil {
			p := path.Clean(strings.TrimPrefix(u.Path, "/api/fs"))
			if !strings.HasPrefix(p, "/") {
				p = "/" + p
			}
			// A move is a write at the destination too, so it gets the same check.
			if !withinRoot(me, p) {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "outside_root"})
				return
			}
			r.Header.Set("Destination", strings.TrimSuffix(s.cfg.Upstream, "/")+p)
		}
	}
	s.proxy.ServeHTTP(w, r)
}

func (s *server) handleQuota(w http.ResponseWriter, r *http.Request) {
	var st syscall.Statfs_t
	target := s.cfg.QuotaPath
	if target == "" {
		target = "/"
	}
	if err := syscall.Statfs(target, &st); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	total := st.Blocks * uint64(st.Bsize)
	free := st.Bavail * uint64(st.Bsize)
	writeJSON(w, http.StatusOK, map[string]any{
		"available": true, "total": total, "free": free, "used": total - free,
	})
}

// --- interface ----------------------------------------------------------

func (s *server) handleStatic(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "" || name == "." {
		name = "index.html"
	}
	body, err := fs.ReadFile(s.web, name)
	if err != nil {
		// An unknown path falls back to the shell, so a bookmarked subfolder
		// opens the app instead of a 404.
		name = "index.html"
		if body, err = fs.ReadFile(s.web, name); err != nil {
			http.NotFound(w, r)
			return
		}
	}
	switch path.Ext(name) {
	case ".html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		body = []byte(strings.NewReplacer(
			`href="app.css"`, `href="app.css?v=`+assetVer+`"`,
			`src="app.js"`, `src="app.js?v=`+assetVer+`"`,
		).Replace(string(body)))
	case ".css", ".js":
		if path.Ext(name) == ".css" {
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		} else {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		}
		// Safe to keep for a year: a change to either file changes the URL.
		if r.URL.Query().Get("v") != "" {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
	case ".svg":
		w.Header().Set("Content-Type", "image/svg+xml")
	case ".webmanifest":
		w.Header().Set("Content-Type", "application/manifest+json")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	// Everything the interface needs comes from this origin: no CDN, no inline
	// script, no third-party module. So the policy can be this narrow.
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "+
			"media-src 'self'; frame-src 'self'; object-src 'none'; "+
			"base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	http.ServeContent(w, r, name, buildTime, bytesReader(body))
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, code: 200}
		next.ServeHTTP(sw, r)
		// Upload slices are the chatty case; keep them, on one short line.
		log.Printf("%s %s %s %d %s", s.clientIP(r), r.Method, r.URL.RequestURI(),
			sw.code, time.Since(start).Round(time.Millisecond))
	})
}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(c int) {
	w.code = c
	w.ResponseWriter.WriteHeader(c)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }

// buildTime is fixed so ServeContent hands out a stable Last-Modified for the
// embedded assets; they only change when the binary does.
var buildTime = time.Now()

// assetVer fingerprints the embedded interface. The stylesheet and the script
// are served under ?v=<fingerprint> and cached hard, while index.html — which
// carries those URLs — is never cached. Without this a CDN happily serves a
// four-hour-old stylesheet next to a fresh script, and the interface breaks in a
// way no amount of redeploying fixes.
var assetVer = fingerprintAssets()

func fingerprintAssets() string {
	h := sha256.New()
	for _, name := range []string{"index.html", "app.css", "app.js"} {
		b, err := fs.ReadFile(webFS(), name)
		if err != nil {
			return strconv.FormatInt(buildTime.Unix(), 36)
		}
		h.Write(b)
	}
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))[:10]
}
