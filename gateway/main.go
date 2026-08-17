// depot-gw place une authentification devant un serveur de fichiers dufs.
//
// dufs ne sait faire que du HTTP Basic, ce qui impose la fenêtre d'identifiants
// du navigateur et interdit toute vraie page de connexion. Ce programme prend
// donc la session à sa charge : il sert l'interface, vérifie un formulaire
// contre des empreintes PBKDF2, délivre un cookie signé, et relaie chaque appel
// de stockage vers dufs sur un réseau interne. dufs n'a aucun compte à lui et
// n'est jamais publié, donc le cookie est la seule entrée — ce qui fait aussi
// que les téléchargements et la lecture vidéo s'authentifient tout seuls, ce
// qu'un en-tête ne peut pas faire depuis un simple <a> ou <video>.
//
// Aucun module externe : tout est en bibliothèque standard, donc l'image se
// construit sans rien télécharger.
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
}

type config struct {
	Listen   string `json:"listen"`
	Upstream string `json:"upstream"`
	// UpstreamAuth vaut « utilisateur:motdepasse » quand dufs garde ses propres
	// comptes. À laisser vide quand dufs tourne ouvert sur un réseau privé ;
	// dans les deux cas le navigateur ne voit jamais de WWW-Authenticate, ce
	// qui est tout l'objet de ce programme.
	UpstreamAuth string `json:"upstream_auth"`
	QuotaPath    string `json:"quota_path"`
	SessionTTL   int    `json:"session_ttl_hours"`
	Secret       string `json:"secret"`
	Title        string `json:"title"`
	Users        []user `json:"users"`
}

type server struct {
	cfg    config
	secret []byte
	proxy  *httputil.ReverseProxy
	web    fs.FS

	mu       sync.Mutex
	attempts map[string]*attempt // freinage des connexions, par IP cliente
}

type attempt struct {
	count int
	until time.Time
}

func main() {
	hashPw := flag.String("hash", "", "print a PBKDF2 hash for this password and exit")
	cfgPath := flag.String("config", "/etc/depot-gw/config.json", "path to the config file")
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
		cfg.Title = "Dépôt"
	}
	if len(cfg.Secret) < 32 {
		log.Fatal("config: secret must be at least 32 characters")
	}
	if len(cfg.Users) == 0 {
		log.Fatal("config: no users defined")
	}

	up, err := url.Parse(cfg.Upstream)
	if err != nil {
		log.Fatalf("parse upstream: %v", err)
	}

	srv := &server{
		cfg:      cfg,
		secret:   []byte(cfg.Secret),
		web:      webFS(),
		attempts: map[string]*attempt{},
	}
	upstreamAuth := ""
	if cfg.UpstreamAuth != "" {
		upstreamAuth = "Basic " + base64.StdEncoding.EncodeToString([]byte(cfg.UpstreamAuth))
	}

	srv.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(up)
			r.Out.Host = up.Host
			// Notre cookie ne veut rien dire en amont, et le client n'a jamais
			// à choisir l'identité utilisée côté stockage.
			r.Out.Header.Del("Cookie")
			r.Out.Header.Del("Authorization")
			if upstreamAuth != "" {
				r.Out.Header.Set("Authorization", upstreamAuth)
			}
		},
		// Vidage fréquent : quand le navigateur se déplace dans une vidéo, la
		// réponse arrive au fil de l'eau au lieu d'un bloc à la fin.
		FlushInterval: 200 * time.Millisecond,
		ModifyResponse: func(resp *http.Response) error {
			// dufs redirige un dossier écrit sans slash final. Ce Location est
			// exprimé dans l'espace de l'amont : le laisser tel quel enverrait
			// le navigateur hors de /api/fs.
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
			http.Error(w, "stockage injoignable", http.StatusBadGateway)
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/login", srv.handleLogin)
	mux.HandleFunc("/api/logout", srv.handleLogout)
	mux.HandleFunc("/api/session", srv.handleSession)
	mux.HandleFunc("/api/quota", srv.requireAuth(srv.handleQuota))
	mux.HandleFunc("/api/fs/", srv.requireAuth(srv.handleFS))
	mux.HandleFunc("/", srv.handleStatic)

	// Ni délai de lecture ni délai d'écriture : une seule tranche d'envoi peut
	// légitimement prendre plusieurs minutes sur une ligne lente, et une
	// connexion bloquée est déjà coupée plus haut par le proxy.
	httpSrv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           logRequests(mux),
		ReadHeaderTimeout: 20 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("depot-gw écoute sur %s, stockage %s", cfg.Listen, cfg.Upstream)
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

func (s *server) sign(name string, exp int64) string {
	payload := name + "." + strconv.FormatInt(exp, 10)
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *server) verify(token string) (string, bool) {
	i := strings.LastIndex(token, ".")
	if i < 0 {
		return "", false
	}
	payload, sig := token[:i], token[i+1:]
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payload))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(sig), []byte(want)) != 1 {
		return "", false
	}
	j := strings.LastIndex(payload, ".")
	if j < 0 {
		return "", false
	}
	name, expStr := payload[:j], payload[j+1:]
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", false
	}
	if s.findUser(name) == nil {
		return "", false
	}
	return name, true
}

func (s *server) findUser(name string) *user {
	for i := range s.cfg.Users {
		if s.cfg.Users[i].Name == name {
			return &s.cfg.Users[i]
		}
	}
	return nil
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("CF-Connecting-IP"); v != "" {
		return v
	}
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	return r.RemoteAddr
}

// throttle réduit un chercheur de mot de passe au pas. Le service est exposé
// sur Internet, et le port SFTP voisin montre déjà à quoi ressemble un balayage
// automatique laissé sans surveillance.
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

func (s *server) noteFailure(ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.attempts[ip]
	// Une fois le blocage purgé, on repart de zéro.
	if a == nil || (a.count >= 5 && time.Now().After(a.until)) {
		a = &attempt{}
		s.attempts[ip] = a
	}
	a.count++
	if a.count >= 5 {
		// 5 essais ratés coûtent une minute, puis deux, puis quatre, plafond à 32.
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
		http.Error(w, "méthode non autorisée", http.StatusMethodNotAllowed)
		return
	}
	ip := clientIP(r)
	if wait := s.throttle(ip); wait > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": fmt.Sprintf("trop de tentatives, réessayez dans %d s", int(wait.Seconds())+1),
		})
		return
	}
	var body struct {
		User     string `json:"user"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		http.Error(w, "requête illisible", http.StatusBadRequest)
		return
	}
	u := s.findUser(body.User)
	// On calcule l'empreinte même pour un compte inconnu : un identifiant
	// absent et un mot de passe faux mettent alors le même temps à répondre.
	ref := "pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	encoded := ref
	if u != nil {
		encoded = u.Hash
	}
	if !checkPassword(body.Password, encoded) || u == nil {
		s.noteFailure(ip)
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "identifiants incorrects"})
		return
	}
	s.noteSuccess(ip)
	exp := time.Now().Add(time.Duration(s.cfg.SessionTTL) * time.Hour)
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    s.sign(u.Name, exp.Unix()),
		Path:     "/",
		Expires:  exp,
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"user": u.Name, "admin": u.Admin})
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) handleSession(w http.ResponseWriter, r *http.Request) {
	name, ok := s.currentUser(r)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"authenticated": false, "title": s.cfg.Title})
		return
	}
	u := s.findUser(name)
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true, "user": name, "admin": u.Admin, "title": s.cfg.Title,
	})
}

func (s *server) currentUser(r *http.Request) (string, bool) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return "", false
	}
	return s.verify(c.Value)
}

func (s *server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := s.currentUser(r); !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "session expirée"})
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

func (s *server) handleFS(w http.ResponseWriter, r *http.Request) {
	if !allowedMethods[r.Method] {
		http.Error(w, "méthode non autorisée", http.StatusMethodNotAllowed)
		return
	}
	// Toute modification doit venir de notre propre code. Un formulaire d'un
	// autre site ne peut pas poser d'en-tête sur mesure, et SameSite=Lax bloque
	// déjà le cookie sur un POST venu d'ailleurs.
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if r.Header.Get("X-Depot") == "" {
			http.Error(w, "en-tête X-Depot manquant", http.StatusForbidden)
			return
		}
	}

	rest := strings.TrimPrefix(r.URL.Path, "/api/fs")
	if rest == "" {
		rest = "/"
	}
	// path.Clean réduit les « .. » avant que dufs ne les voie.
	clean := path.Clean(rest)
	if !strings.HasPrefix(clean, "/") {
		clean = "/" + clean
	}
	if strings.HasSuffix(rest, "/") && clean != "/" {
		clean += "/"
	}
	r.URL.Path = clean

	// MOVE transporte un Destination qui pointe vers nous ; il faut le réécrire
	// dans l'espace de l'amont, sinon dufs le rejette comme hôte étranger.
	if dest := r.Header.Get("Destination"); dest != "" {
		if u, err := url.Parse(dest); err == nil {
			p := path.Clean(strings.TrimPrefix(u.Path, "/api/fs"))
			if !strings.HasPrefix(p, "/") {
				p = "/" + p
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
		// Un chemin inconnu retombe sur la coquille : un sous-dossier mis en
		// favori ouvre l'application au lieu d'un 404.
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
	case ".css":
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case ".js":
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	case ".svg":
		w.Header().Set("Content-Type", "image/svg+xml")
	case ".webmanifest":
		w.Header().Set("Content-Type", "application/manifest+json")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.ServeContent(w, r, name, buildTime, bytesReader(body))
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, code: 200}
		next.ServeHTTP(sw, r)
		// Les tranches d'envoi sont le cas bavard : on les garde, sur une ligne.
		log.Printf("%s %s %s %d %s", clientIP(r), r.Method, r.URL.RequestURI(),
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

// buildTime est figé pour que ServeContent annonce un Last-Modified stable sur
// les fichiers embarqués : ils ne changent qu'avec le binaire.
var buildTime = time.Now()
