class_name Net
extends Node
## Connection to the flowbreaker daemon (docs/protocol.md). Finds the daemon
## via, in order: --url/--token command-line args, FLOWBREAKER_URL /
## FLOWBREAKER_TOKEN env vars, or the session file the daemon writes to
## $XDG_RUNTIME_DIR/flowbreaker.json. With --demo a local simulator stands in.

signal message(msg: Dictionary)
signal status(state: String, detail: String)

var demo: DemoSim
var _ws := WebSocketPeer.new()
var _url := ""
var _open := false
var _retry := 0.0
var _hb := 0.0


func _ready() -> void:
	var args := Main.user_args()
	if args.has("demo"):
		demo = DemoSim.new()
		demo.message.connect(func(m): message.emit(m))
		add_child(demo)
		status.emit("demo", "simulated traffic, nothing is dropped")
		return
	_ws.inbound_buffer_size = 1 << 20
	_try_connect()


func _resolve() -> String:
	var args := Main.user_args()
	var url: String = args.get("url", OS.get_environment("FLOWBREAKER_URL"))
	var token: String = args.get("token", OS.get_environment("FLOWBREAKER_TOKEN"))
	if url == "" or token == "":
		var path := OS.get_environment("XDG_RUNTIME_DIR").path_join("flowbreaker.json")
		if FileAccess.file_exists(path):
			var s = JSON.parse_string(FileAccess.get_file_as_string(path))
			if s is Dictionary:
				if url == "":
					url = "ws://%s/ws" % s.get("listen", "127.0.0.1:8088")
				if token == "":
					token = s.get("token", "")
	if url == "":
		url = "ws://127.0.0.1:8088/ws"
	if token == "":
		return ""
	return "%s?token=%s" % [url, token.uri_encode()]


func _try_connect() -> void:
	_url = _resolve()
	if _url == "":
		status.emit("waiting", "start the daemon: sudo ./flowbreaker -iface <dev>")
		_retry = 2.0
		return
	var err := _ws.connect_to_url(_url)
	if err != OK:
		status.emit("offline", "connect failed (%s)" % error_string(err))
		_retry = 2.0
		return
	status.emit("connecting", _url.split("?")[0])


func _process(delta: float) -> void:
	if demo:
		return
	if _retry > 0.0:
		_retry -= delta
		if _retry <= 0.0:
			_try_connect()
		return
	_ws.poll()
	match _ws.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			if not _open:
				_open = true
				status.emit("online", _url.split("?")[0])
			while _ws.get_available_packet_count() > 0:
				var m = JSON.parse_string(_ws.get_packet().get_string_from_utf8())
				if m is Dictionary:
					message.emit(m)
			_hb -= delta
			if _hb <= 0.0:
				_hb = 3.0
				send({"t": "hb"})
		WebSocketPeer.STATE_CLOSED:
			if _open:
				_open = false
			status.emit("offline", "daemon closed the connection (%d), retrying" % _ws.get_close_code())
			_ws = WebSocketPeer.new()
			_ws.inbound_buffer_size = 1 << 20
			_retry = 2.0


func send(m: Dictionary) -> void:
	if demo:
		demo.handle(m)
	elif _ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_ws.send_text(JSON.stringify(m))
