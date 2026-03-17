package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

// ---- types ----

type RawContentBlock struct {
	Type     string          `json:"type"`
	Text     string          `json:"text"`
	Thinking string          `json:"thinking"`
	Name     string          `json:"name"`
	ID       string          `json:"id"`
	Input    json.RawMessage `json:"input"`
	Content  json.RawMessage `json:"content"`
	IsError  bool            `json:"is_error"`
}

type RawMessage struct {
	Role    string            `json:"role"`
	Content json.RawMessage   `json:"content"`
	Model   string            `json:"model"`
}

type RawEntry struct {
	Type                   string          `json:"type"`
	Timestamp              string          `json:"timestamp"`
	UUID                   string          `json:"uuid"`
	ParentUUID             *string         `json:"parentUuid"`
	IsMeta                 bool            `json:"isMeta"`
	CWD                    string          `json:"cwd"`
	GitBranch              string          `json:"gitBranch"`
	SourceToolUseID        string          `json:"sourceToolUseID"`
	SourceToolAssistantUUID string         `json:"sourceToolAssistantUUID"`
	ToolUseResult          json.RawMessage `json:"toolUseResult"`
	Operation              string          `json:"operation"`
	Content                json.RawMessage `json:"content"`
	Message                *RawMessage     `json:"message"`
}

type SessionEntry struct {
	ID         string                 `json:"id"`
	RawType    string                 `json:"rawType"`
	Kind       string                 `json:"kind"`
	Text       string                 `json:"text"`
	Timestamp  *string                `json:"timestamp"`
	ParentUUID *string                `json:"parentUuid,omitempty"`
	Meta       map[string]interface{} `json:"meta,omitempty"`
}

type ParsedSession struct {
	SessionID string         `json:"sessionId"`
	ProjectID string         `json:"projectId"`
	FilePath  string         `json:"filePath"`
	CWD       *string        `json:"cwd"`
	Entries   []SessionEntry `json:"entries"`
	RawCount  int            `json:"rawCount"`
	UpdatedAt *string        `json:"updatedAt"`
}

type ClientEvent map[string]interface{}

type SessionListItem struct {
	ProjectID     string  `json:"projectId"`
	SessionID     string  `json:"sessionId"`
	FilePath      string  `json:"filePath"`
	CWD           *string `json:"cwd"`
	FirstUserText *string `json:"firstUserText"`
	UpdatedAt     *string `json:"updatedAt"`
}

// ---- helpers ----

func sanitizeText(v json.RawMessage) string {
	if v == nil {
		return ""
	}
	var s string
	if err := json.Unmarshal(v, &s); err == nil {
		return strings.TrimSpace(s)
	}
	var blocks []RawContentBlock
	if err := json.Unmarshal(v, &blocks); err == nil {
		var parts []string
		for _, b := range blocks {
			switch b.Type {
			case "text":
				if t := strings.TrimSpace(b.Text); t != "" {
					parts = append(parts, t)
				}
			case "thinking":
				if t := strings.TrimSpace(b.Thinking); t != "" {
					parts = append(parts, t)
				}
			case "tool_use":
				if b.Name != "" {
					parts = append(parts, "[tool:"+b.Name+"]")
				} else {
					parts = append(parts, "[tool]")
				}
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n"))
	}
	return strings.TrimSpace(string(v))
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func parseEntry(entry RawEntry, idx int) []SessionEntry {
	ts := strPtr(entry.Timestamp)
	idBase := entry.UUID
	if idBase == "" {
		idBase = fmt.Sprintf("%s-%d", entry.Type, idx)
	}
	parent := entry.ParentUUID

	switch entry.Type {
	case "queue-operation":
		op := entry.Operation
		if op == "" {
			op = "queue"
		}
		text := op
		if c := sanitizeText(entry.Content); c != "" {
			text = op + ": " + c
		}
		return []SessionEntry{{ID: idBase + "-queue", RawType: entry.Type, Kind: "queue", Text: text, Timestamp: ts, ParentUUID: parent}}

	case "last-prompt":
		return nil

	case "summary":
		text := ""
		if entry.Message != nil {
			text = sanitizeText(entry.Message.Content)
		}
		if text == "" {
			text = sanitizeText(entry.Content)
		}
		return []SessionEntry{{ID: idBase + "-summary", RawType: entry.Type, Kind: "summary", Text: text, Timestamp: ts, ParentUUID: parent}}

	case "user":
		if entry.IsMeta || entry.SourceToolUseID != "" || entry.ToolUseResult != nil {
			resultText := sanitizeText(entry.ToolUseResult)
			if resultText == "" && entry.Message != nil {
				resultText = sanitizeText(entry.Message.Content)
			}
			if resultText == "" {
				resultText = "[tool result]"
			}
			meta := map[string]interface{}{
				"sourceToolUseID":         entry.SourceToolUseID,
				"sourceToolAssistantUUID": entry.SourceToolAssistantUUID,
			}
			return []SessionEntry{{ID: idBase + "-tool-result", RawType: entry.Type, Kind: "tool_result", Text: resultText, Timestamp: ts, ParentUUID: parent, Meta: meta}}
		}
		text := ""
		if entry.Message != nil {
			text = sanitizeText(entry.Message.Content)
		}
		if text == "" {
			text = sanitizeText(entry.Content)
		}
		meta := map[string]interface{}{"cwd": entry.CWD, "gitBranch": entry.GitBranch}
		return []SessionEntry{{ID: idBase + "-user", RawType: entry.Type, Kind: "user", Text: text, Timestamp: ts, ParentUUID: parent, Meta: meta}}

	case "assistant":
		if entry.Message == nil {
			return nil
		}
		var blocks []RawContentBlock
		if err := json.Unmarshal(entry.Message.Content, &blocks); err != nil {
			text := sanitizeText(entry.Message.Content)
			return []SessionEntry{{ID: idBase + "-assistant", RawType: entry.Type, Kind: "assistant", Text: text, Timestamp: ts, ParentUUID: parent}}
		}
		var entries []SessionEntry
		for i, b := range blocks {
			switch b.Type {
			case "text":
				if t := strings.TrimSpace(b.Text); t != "" {
					meta := map[string]interface{}{"model": entry.Message.Model}
					entries = append(entries, SessionEntry{ID: fmt.Sprintf("%s-text-%d", idBase, i), RawType: entry.Type, Kind: "assistant", Text: t, Timestamp: ts, ParentUUID: parent, Meta: meta})
				}
			case "thinking":
				if t := strings.TrimSpace(b.Thinking); t != "" {
					entries = append(entries, SessionEntry{ID: fmt.Sprintf("%s-thinking-%d", idBase, i), RawType: entry.Type, Kind: "thinking", Text: t, Timestamp: ts, ParentUUID: parent})
				}
			case "tool_use":
				inputStr := strings.TrimSpace(string(b.Input))
				text := b.Name + "\n" + inputStr
				meta := map[string]interface{}{"toolId": b.ID, "name": b.Name}
				entries = append(entries, SessionEntry{ID: fmt.Sprintf("%s-tool-%d", idBase, i), RawType: entry.Type, Kind: "tool_use", Text: strings.TrimSpace(text), Timestamp: ts, ParentUUID: parent, Meta: meta})
			}
		}
		return entries
	}

	text := sanitizeText(entry.Content)
	if text == "" && entry.Message != nil {
		text = sanitizeText(entry.Message.Content)
	}
	if text == "" {
		text = entry.Type
	}
	return []SessionEntry{{ID: idBase + "-system", RawType: entry.Type, Kind: "system", Text: text, Timestamp: ts, ParentUUID: parent}}
}

func getDefaultClaudeRoot() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

func getProjectsDir(claudeRoot string) string {
	return filepath.Join(claudeRoot, "projects")
}

func loadSession(projectID, sessionID, filePath string) (ParsedSession, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return ParsedSession{}, err
	}
	defer f.Close()

	var entries []SessionEntry
	var cwd *string
	rawCount := 0

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4*1024*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		rawCount++
		var raw RawEntry
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			entries = append(entries, SessionEntry{ID: fmt.Sprintf("parse-error-%d", rawCount), RawType: "parse-error", Kind: "error", Text: line})
			continue
		}
		if cwd == nil && raw.CWD != "" {
			cwd = &raw.CWD
		}
		entries = append(entries, parseEntry(raw, rawCount)...)
	}

	info, _ := os.Stat(filePath)
	var updatedAt *string
	if info != nil {
		t := info.ModTime().UTC().Format(time.RFC3339)
		updatedAt = &t
	}

	return ParsedSession{
		SessionID: sessionID,
		ProjectID: projectID,
		FilePath:  filePath,
		CWD:       cwd,
		Entries:   entries,
		RawCount:  rawCount,
		UpdatedAt: updatedAt,
	}, nil
}

func discoverSessions(claudeRoot string) ([]SessionListItem, error) {
	projectsDir := getProjectsDir(claudeRoot)
	projectEntries, err := os.ReadDir(projectsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var results []SessionListItem
	for _, pe := range projectEntries {
		if !pe.IsDir() {
			continue
		}
		projectID := pe.Name()
		projectPath := filepath.Join(projectsDir, projectID)
		files, _ := os.ReadDir(projectPath)
		for _, fe := range files {
			if !fe.Type().IsRegular() || !strings.HasSuffix(fe.Name(), ".jsonl") || strings.HasPrefix(fe.Name(), "agent-") {
				continue
			}
			filePath := filepath.Join(projectPath, fe.Name())
			sessionID := strings.TrimSuffix(fe.Name(), ".jsonl")
			item := extractListMeta(projectID, sessionID, filePath)
			results = append(results, item)
		}
	}

	sort.Slice(results, func(i, j int) bool {
		ai, bi := "", ""
		if results[i].UpdatedAt != nil {
			ai = *results[i].UpdatedAt
		}
		if results[j].UpdatedAt != nil {
			bi = *results[j].UpdatedAt
		}
		return ai > bi
	})
	return results, nil
}

func extractListMeta(projectID, sessionID, filePath string) SessionListItem {
	var cwd *string
	var firstUserText *string

	f, err := os.Open(filePath)
	if err == nil {
		defer f.Close()
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 4*1024*1024), 4*1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var raw RawEntry
			if err := json.Unmarshal([]byte(line), &raw); err != nil {
				continue
			}
			if cwd == nil && raw.CWD != "" {
				cwd = &raw.CWD
			}
			if firstUserText == nil && raw.Type == "user" && !raw.IsMeta {
				text := ""
				if raw.Message != nil {
					text = sanitizeText(raw.Message.Content)
				}
				if text == "" {
					text = sanitizeText(raw.Content)
				}
				if text != "" {
					text = strings.Join(strings.Fields(text), " ")
					if len(text) > 140 {
						text = text[:140]
					}
					firstUserText = &text
				}
			}
			if cwd != nil && firstUserText != nil {
				break
			}
		}
	}

	info, _ := os.Stat(filePath)
	var updatedAt *string
	if info != nil {
		t := info.ModTime().UTC().Format(time.RFC3339)
		updatedAt = &t
	}

	return SessionListItem{
		ProjectID:     projectID,
		SessionID:     sessionID,
		FilePath:      filePath,
		CWD:           cwd,
		FirstUserText: firstUserText,
		UpdatedAt:     updatedAt,
	}
}

func resolveSessionFile(claudeRoot string, sessionID, projectID, filePath, sessionCWD string) (pID, sID, fPath string, err error) {
	if filePath != "" {
		abs, _ := filepath.Abs(filePath)
		sID = strings.TrimSuffix(filepath.Base(abs), ".jsonl")
		pID = filepath.Base(filepath.Dir(abs))
		return pID, sID, abs, nil
	}
	if sessionID == "" {
		return "", "", "", fmt.Errorf("missing --session")
	}
	if projectID != "" {
		fPath = filepath.Join(getProjectsDir(claudeRoot), projectID, sessionID+".jsonl")
		return projectID, sessionID, fPath, nil
	}
	sessions, err := discoverSessions(claudeRoot)
	if err != nil {
		return "", "", "", err
	}
	for _, s := range sessions {
		if s.SessionID == sessionID {
			return s.ProjectID, s.SessionID, s.FilePath, nil
		}
	}
	// Fallback: construct path from CWD (session file may not exist yet)
	if sessionCWD != "" {
		encodedCWD := strings.ReplaceAll(sessionCWD, "/", "-")
		if strings.HasPrefix(encodedCWD, "-") {
			encodedCWD = encodedCWD[1:]
		}
		inferredProjectID := "-" + strings.ReplaceAll(sessionCWD[1:], "/", "-")
		fPath = filepath.Join(getProjectsDir(claudeRoot), inferredProjectID, sessionID+".jsonl")
		if _, statErr := os.Stat(fPath); statErr == nil {
			return inferredProjectID, sessionID, fPath, nil
		}
		// Try all project dirs for a matching session file
		projectEntries, _ := os.ReadDir(getProjectsDir(claudeRoot))
		for _, pe := range projectEntries {
			if !pe.IsDir() {
				continue
			}
			candidate := filepath.Join(getProjectsDir(claudeRoot), pe.Name(), sessionID+".jsonl")
			if _, statErr := os.Stat(candidate); statErr == nil {
				return pe.Name(), sessionID, candidate, nil
			}
		}
	}
	return "", "", "", fmt.Errorf("session %s not found", sessionID)
}

// ---- server ----

type Server struct {
	claudeRoot      string
	projectID       string
	sessionID       string
	filePath        string
	port            int
	host            string
	publicBaseURL   string
	claudeBin       string
	runAsUser       string
	ownerHome       string
	allowInput      bool
	allowDangerous  bool

	token   string
	mu      sync.Mutex
	session ParsedSession
	busy    bool
	clients map[*websocket.Conn]struct{}
}

func (s *Server) shareURL() string {
	if s.publicBaseURL != "" {
		return strings.TrimRight(s.publicBaseURL, "/") + "/s/" + s.token
	}
	host := s.host
	if host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return fmt.Sprintf("http://%s:%d/s/%s", host, s.port, s.token)
}

func (s *Server) broadcast(event ClientEvent) {
	s.mu.Lock()
	conns := make([]*websocket.Conn, 0, len(s.clients))
	for c := range s.clients {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	for _, c := range conns {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = wsjson.Write(ctx, c, event)
		cancel()
	}
}

func (s *Server) bootstrapEvent(shareURL string) ClientEvent {
	s.mu.Lock()
	sess := s.session
	busy := s.busy
	s.mu.Unlock()
	return ClientEvent{
		"type":       "bootstrap",
		"session":    sess,
		"busy":       busy,
		"shareUrl":   shareURL,
		"allowInput": s.allowInput,
	}
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	s.mu.Lock()
	s.clients[c] = struct{}{}
	s.mu.Unlock()

	shareURL := s.shareURL()
	fwd := r.Header.Get("x-forwarded-host")
	proto := r.Header.Get("x-forwarded-proto")
	if fwd != "" && proto != "" {
		shareURL = proto + "://" + fwd + "/s/" + s.token
	}

	ctx := c.CloseRead(context.Background())
	_ = wsjson.Write(ctx, c, s.bootstrapEvent(shareURL))
	<-ctx.Done()

	s.mu.Lock()
	delete(s.clients, c)
	s.mu.Unlock()
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	shareURL := s.shareURL()
	fwd := r.Header.Get("x-forwarded-host")
	proto := r.Header.Get("x-forwarded-proto")
	if fwd != "" && proto != "" {
		shareURL = proto + "://" + fwd + "/s/" + s.token
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.bootstrapEvent(shareURL))
}

func (s *Server) handleMessage(w http.ResponseWriter, r *http.Request) {
	if !s.allowInput {
		http.Error(w, "Session is read-only.", 403)
		return
	}
	s.mu.Lock()
	if s.busy {
		s.mu.Unlock()
		http.Error(w, "Claude is already processing another message.", 409)
		return
	}
	s.mu.Unlock()

	var body struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Message) == "" {
		http.Error(w, "Missing message.", 400)
		return
	}

	go s.resume(strings.TrimSpace(body.Message))
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (s *Server) resume(message string) {
	s.mu.Lock()
	s.busy = true
	s.mu.Unlock()
	s.broadcast(ClientEvent{"type": "status", "busy": true, "message": "Running Claude for this session..."})

	defer func() {
		s.mu.Lock()
		s.busy = false
		s.mu.Unlock()
	}()

	result, err := s.runClaude(message)
	if err != nil {
		s.broadcast(ClientEvent{"type": "error", "message": err.Error()})
		return
	}
	s.broadcast(ClientEvent{"type": "status", "busy": true, "message": result})
	time.Sleep(300 * time.Millisecond)

	sess, err := loadSession(s.projectID, s.sessionID, s.filePath)
	if err == nil {
		s.mu.Lock()
		s.session = sess
		s.mu.Unlock()
	}
	s.broadcast(ClientEvent{"type": "reload", "session": sess, "busy": false})
	s.broadcast(ClientEvent{"type": "status", "busy": false, "message": "Claude finished."})
}

func (s *Server) runClaude(message string) (string, error) {
	home := s.ownerHome
	if home == "" {
		if s.runAsUser != "" {
			home = "/home/" + s.runAsUser
		} else {
			home, _ = os.UserHomeDir()
		}
	}

	args := []string{s.claudeBin, "-p", "--resume", s.sessionID, "--output-format", "json"}
	if s.allowDangerous {
		args = append(args, "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions")
	}
	args = append(args, message)

	var cmd *exec.Cmd
	if s.runAsUser != "" && os.Getuid() == 0 {
		runArgs := append([]string{"-u", s.runAsUser, "--", "env", "HOME=" + home}, args...)
		cmd = exec.Command("runuser", runArgs...)
	} else {
		cmd = exec.Command(args[0], args[1:]...)
	}

	s.mu.Lock()
	cwd := ""
	if s.session.CWD != nil {
		cwd = *s.session.CWD
	}
	s.mu.Unlock()
	if cwd == "" {
		cwd = filepath.Dir(s.filePath)
	}
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "HOME="+home)

	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("%s", strings.TrimSpace(string(ee.Stderr)))
		}
		return "", err
	}

	var result struct {
		Result  string `json:"result"`
		IsError bool   `json:"is_error"`
		Error   string `json:"error"`
		Subtype string `json:"subtype"`
	}
	if err := json.Unmarshal(out, &result); err == nil {
		if result.IsError {
			return "", fmt.Errorf("%s", result.Error)
		}
		if result.Result != "" {
			return strings.TrimSpace(result.Result), nil
		}
		if result.Subtype != "" {
			return result.Subtype, nil
		}
	}
	return strings.TrimSpace(string(out)), nil
}

func (s *Server) watchFile(ctx context.Context) {
	lastSize := int64(0)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			info, err := os.Stat(s.filePath)
			if err != nil {
				continue
			}
			if info.Size() != lastSize {
				lastSize = info.Size()
				sess, err := loadSession(s.projectID, s.sessionID, s.filePath)
				if err != nil {
					continue
				}
				s.mu.Lock()
				s.session = sess
				busy := s.busy
				s.mu.Unlock()
				s.broadcast(ClientEvent{"type": "reload", "session": sess, "busy": busy})
			}
		}
	}
}

func (s *Server) start() error {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	s.token = hex.EncodeToString(b)
	s.clients = make(map[*websocket.Conn]struct{})

	sess, err := loadSession(s.projectID, s.sessionID, s.filePath)
	if err != nil {
		return err
	}
	s.session = sess

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			fmt.Fprintf(w, "Claude Session Share\n\nShare URL: %s\nSession: %s\n", s.shareURL(), s.sessionID)
			return
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("/s/"+s.token, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(htmlPage))
	})
	mux.HandleFunc("/ws/"+s.token, s.handleWS)
	mux.HandleFunc("/api/share/"+s.token+"/history", s.handleHistory)
	mux.HandleFunc("/api/share/"+s.token+"/message", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		s.handleMessage(w, r)
	})

	ctx, cancel := context.WithCancel(context.Background())
	go s.watchFile(ctx)

	srv := &http.Server{
		Addr:    fmt.Sprintf("%s:%d", s.host, s.port),
		Handler: mux,
	}

	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		cancel()
		return err
	}

	shareURL := s.shareURL()
	fmt.Printf("Session file: %s\n", s.filePath)
	fmt.Printf("Share URL: %s\n", shareURL)

	// Print LAN URLs when binding to all interfaces
	if s.host == "0.0.0.0" || s.host == "::" {
		ifaces, _ := net.Interfaces()
		for _, iface := range ifaces {
			addrs, _ := iface.Addrs()
			for _, addr := range addrs {
				var ip net.IP
				switch v := addr.(type) {
				case *net.IPNet:
					ip = v.IP
				case *net.IPAddr:
					ip = v.IP
				}
				if ip == nil || ip.IsLoopback() {
					continue
				}
				alt := fmt.Sprintf("http://%s:%d/s/%s", ip.String(), s.port, s.token)
				if alt != shareURL {
					fmt.Printf("Reachable URL: %s\n", alt)
				}
			}
		}
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		cancel()
		_ = srv.Shutdown(context.Background())
	}()

	err = srv.Serve(ln)
	cancel()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

// ---- CLI ----

func parseFlags(args []string) map[string]string {
	flags := make(map[string]string)
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "--") {
			continue
		}
		key := args[i][2:]
		if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
			flags[key] = args[i+1]
			i++
		} else {
			flags[key] = "true"
		}
	}
	return flags
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		fmt.Println("claude-session-share\n\nCommands:\n  list --claude-root <path>\n  serve --session <id> [--claude-root <path>] [--host <h>] [--port <p>] [--read-only] [--dangerously-skip-permissions]")
		return
	}

	cmd := args[0]
	flags := parseFlags(args[1:])

	claudeRoot := flags["claude-root"]
	if claudeRoot == "" {
		claudeRoot = getDefaultClaudeRoot()
	}
	claudeRoot, _ = filepath.Abs(claudeRoot)

	switch cmd {
	case "list":
		sessions, err := discoverSessions(claudeRoot)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if len(sessions) == 0 {
			fmt.Println("No sessions found.")
			return
		}
		for _, s := range sessions[:min(50, len(sessions))] {
			updated := "-"
			if s.UpdatedAt != nil {
				updated = *s.UpdatedAt
			}
			preview := "(no user text)"
			if s.FirstUserText != nil {
				preview = *s.FirstUserText
			}
			fmt.Printf("%s | %s | %s | %s\n", s.SessionID, s.ProjectID, updated, preview)
		}

	case "serve":
		projectID, sessionID, filePath, err := resolveSessionFile(claudeRoot, flags["session"], flags["project"], flags["session-file"], flags["session-cwd"])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}

		port := 3939
		if p, ok := flags["port"]; ok {
			if n, err := strconv.Atoi(p); err == nil {
				port = n
			}
		}
		host := flags["host"]
		if host == "" {
			host = "0.0.0.0"
		}
		claudeBin := flags["claude-bin"]
		if claudeBin == "" {
			claudeBin = "claude"
		}

		srv := &Server{
			claudeRoot:     claudeRoot,
			projectID:      projectID,
			sessionID:      sessionID,
			filePath:       filePath,
			port:           port,
			host:           host,
			publicBaseURL:  flags["public-base-url"],
			claudeBin:      claudeBin,
			runAsUser:      flags["run-as-user"],
			ownerHome:      flags["owner-home"],
			allowInput:     flags["read-only"] != "true",
			allowDangerous: flags["dangerously-skip-permissions"] == "true",
		}
		if err := srv.start(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}

	default:
		fmt.Fprintln(os.Stderr, "unknown command:", cmd)
		os.Exit(1)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
