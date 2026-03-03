"""
봄소리 호스트 — GUI (tkinter)
라이브 방송 (마이크+PC사운드) + 파일 방송 (트랙 업로드/관리/ON AIR)
"""

import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import threading
import time
import json
import os
import ctypes
import sys

import config
from audio_engine import AudioEngine, list_audio_devices
from uploader import Uploader
from api_client import ApiClient, get_audio_duration

SETTINGS_FILE = os.path.join(os.path.dirname(__file__), "settings.json")

AUDIO_FILETYPES = [
    ("오디오 파일", "*.mp3 *.m4a *.ogg *.wav *.flac *.aac"),
    ("모든 파일", "*.*"),
]


def load_settings():
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_settings(data):
    try:
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


class HostApp:
    def __init__(self, root):
        self.root = root
        self.root.title(config.WINDOW_TITLE)
        self.root.geometry(config.WINDOW_SIZE)
        self.root.resizable(False, False)
        self.root.configure(bg="#1a1726")

        # 라이브 방송 상태
        self.engine = None
        self.uploader = None
        self.is_broadcasting = False
        self.start_time = None
        self.timer_id = None

        # 파일 방송 상태
        self.api_client = None
        self.tracks = []
        self.ch5_state = {}
        self.file_poll_id = None
        self.is_file_on_air = False
        self.uploading = False

        settings = load_settings()

        # ── 스타일 ──────────────────────────────────────────
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TFrame", background="#1a1726")
        style.configure("TLabel", background="#1a1726", foreground="#ece4d8",
                         font=("맑은 고딕", 9))
        style.configure("Header.TLabel", font=("맑은 고딕", 14, "bold"),
                         foreground="#e8c47c")
        style.configure("Status.TLabel", font=("맑은 고딕", 10),
                         foreground="#90c090")
        style.configure("Warning.TLabel", font=("맑은 고딕", 9),
                         foreground="#e07070", background="#1a1726")
        style.configure("OnAir.TLabel", font=("맑은 고딕", 10, "bold"),
                         foreground="#e8c47c", background="#1a1726")
        style.configure("TButton", font=("맑은 고딕", 10))
        style.configure("Start.TButton", font=("맑은 고딕", 12, "bold"))
        style.configure("TNotebook", background="#1a1726")
        style.configure("TNotebook.Tab", font=("맑은 고딕", 10, "bold"),
                         padding=[12, 4])
        style.configure("TLabelframe", background="#1a1726")
        style.configure("TLabelframe.Label", background="#1a1726",
                         foreground="#ece4d8", font=("맑은 고딕", 9))
        style.configure("Treeview", font=("맑은 고딕", 9), rowheight=24)
        style.configure("Treeview.Heading", font=("맑은 고딕", 9, "bold"))

        main = ttk.Frame(root, padding=12)
        main.pack(fill=tk.BOTH, expand=True)

        # ── 헤더 ────────────────────────────────────────────
        ttk.Label(main, text="봄소리 호스트", style="Header.TLabel").pack(pady=(0, 8))

        # ── 공통 설정 ────────────────────────────────────────
        settings_frame = ttk.LabelFrame(main, text="서버 설정", padding=6)
        settings_frame.pack(fill=tk.X, pady=(0, 6))

        ttk.Label(settings_frame, text="Workers URL:").grid(row=0, column=0, sticky=tk.W, pady=2)
        self.url_var = tk.StringVar(value=settings.get("worker_url", ""))
        ttk.Entry(settings_frame, textvariable=self.url_var, width=44).grid(
            row=0, column=1, pady=2, padx=(4, 0))

        ttk.Label(settings_frame, text="Admin Key:").grid(row=1, column=0, sticky=tk.W, pady=2)
        self.key_var = tk.StringVar(value=settings.get("admin_key", ""))
        ttk.Entry(settings_frame, textvariable=self.key_var, show="*", width=44).grid(
            row=1, column=1, pady=2, padx=(4, 0))

        # ── 탭 ──────────────────────────────────────────────
        self.notebook = ttk.Notebook(main)
        self.notebook.pack(fill=tk.BOTH, expand=True, pady=(4, 0))

        self._build_live_tab(settings)
        self._build_file_tab(settings)

        # 마지막 탭 복원
        last_tab = settings.get("last_tab", 0)
        if last_tab in (0, 1):
            self.notebook.select(last_tab)

        # 탭 변경 시 파일 방송 탭이면 폴링 시작
        self.notebook.bind("<<NotebookTabChanged>>", self._on_tab_changed)

        # 종료 시 정리
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    # ══════════════════════════════════════════════════════
    # 라이브 방송 탭
    # ══════════════════════════════════════════════════════

    def _build_live_tab(self, settings):
        tab = ttk.Frame(self.notebook, padding=8)
        self.notebook.add(tab, text=" 라이브 방송 ")

        # 방송 제목
        title_frame = ttk.Frame(tab)
        title_frame.pack(fill=tk.X, pady=(0, 6))
        ttk.Label(title_frame, text="방송 제목:").pack(side=tk.LEFT)
        self.title_var = tk.StringVar(value=settings.get("title", ""))
        ttk.Entry(title_frame, textvariable=self.title_var, width=38).pack(
            side=tk.LEFT, padx=(4, 0))

        # 오디오 장치
        device_frame = ttk.LabelFrame(tab, text="오디오 장치", padding=6)
        device_frame.pack(fill=tk.X, pady=(0, 6))

        self.devices = list_audio_devices()
        device_names = ["(사용 안 함)"] + self.devices

        ttk.Label(device_frame, text="마이크:").grid(row=0, column=0, sticky=tk.W, pady=2)
        self.mic_var = tk.StringVar(value=settings.get("mic_device", "(사용 안 함)"))
        self.mic_combo = ttk.Combobox(device_frame, textvariable=self.mic_var,
                                       values=device_names, width=34, state="readonly")
        self.mic_combo.grid(row=0, column=1, pady=2, padx=(4, 0))

        ttk.Label(device_frame, text="PC 사운드:").grid(row=1, column=0, sticky=tk.W, pady=2)
        self.sys_var = tk.StringVar(value=settings.get("sys_device", "(사용 안 함)"))
        self.sys_combo = ttk.Combobox(device_frame, textvariable=self.sys_var,
                                       values=device_names, width=34, state="readonly")
        self.sys_combo.grid(row=1, column=1, pady=2, padx=(4, 0))

        ttk.Button(device_frame, text="장치 새로고침", command=self.refresh_devices).grid(
            row=2, column=1, sticky=tk.E, pady=4)

        # 볼륨
        vol_frame = ttk.LabelFrame(tab, text="볼륨", padding=6)
        vol_frame.pack(fill=tk.X, pady=(0, 6))

        ttk.Label(vol_frame, text="마이크:").grid(row=0, column=0, sticky=tk.W)
        self.mic_vol = tk.DoubleVar(value=settings.get("mic_vol", 1.0))
        ttk.Scale(vol_frame, from_=0, to=2.0, variable=self.mic_vol,
                  orient=tk.HORIZONTAL, length=240).grid(row=0, column=1)

        ttk.Label(vol_frame, text="PC 사운드:").grid(row=1, column=0, sticky=tk.W)
        self.sys_vol = tk.DoubleVar(value=settings.get("sys_vol", 1.0))
        ttk.Scale(vol_frame, from_=0, to=2.0, variable=self.sys_vol,
                  orient=tk.HORIZONTAL, length=240).grid(row=1, column=1)

        # 시작/종료 버튼
        self.live_start_btn = ttk.Button(tab, text="방송 시작", style="Start.TButton",
                                          command=self.toggle_live)
        self.live_start_btn.pack(fill=tk.X, ipady=6, pady=(4, 6))

        # 상태
        self.live_status_var = tk.StringVar(value="대기 중")
        ttk.Label(tab, textvariable=self.live_status_var, style="Status.TLabel").pack(pady=(0, 2))

        self.live_timer_var = tk.StringVar(value="")
        ttk.Label(tab, textvariable=self.live_timer_var, font=("맑은 고딕", 18, "bold"),
                  background="#1a1726", foreground="#e8c47c").pack()

        self.live_chunk_var = tk.StringVar(value="")
        ttk.Label(tab, textvariable=self.live_chunk_var,
                  background="#1a1726", foreground="#8a8078", font=("맑은 고딕", 8)).pack()

        # 파일 ON AIR 잠금 경고
        self.live_lock_var = tk.StringVar(value="")
        self.live_lock_label = ttk.Label(tab, textvariable=self.live_lock_var,
                                          style="Warning.TLabel")
        self.live_lock_label.pack(pady=(4, 0))

    # ══════════════════════════════════════════════════════
    # 파일 방송 탭
    # ══════════════════════════════════════════════════════

    def _build_file_tab(self, settings):
        tab = ttk.Frame(self.notebook, padding=8)
        self.notebook.add(tab, text=" 파일 방송 ")

        # 파일 선택 & 업로드
        upload_frame = ttk.Frame(tab)
        upload_frame.pack(fill=tk.X, pady=(0, 6))

        ttk.Button(upload_frame, text="파일 선택...", command=self._select_files).pack(
            side=tk.LEFT)
        self.upload_btn = ttk.Button(upload_frame, text="업로드", command=self._upload_files,
                                      state=tk.DISABLED)
        self.upload_btn.pack(side=tk.LEFT, padx=(6, 0))

        self.upload_info_var = tk.StringVar(value="")
        ttk.Label(upload_frame, textvariable=self.upload_info_var).pack(
            side=tk.LEFT, padx=(8, 0))

        # 업로드 진행바
        self.upload_progress = ttk.Progressbar(tab, mode="determinate", length=460)
        # pack하지 않음 — 업로드 시에만 표시

        # 트랙 목록
        track_frame = ttk.LabelFrame(tab, text="트랙 목록", padding=6)
        track_frame.pack(fill=tk.BOTH, expand=True, pady=(0, 6))

        # Treeview
        tree_container = ttk.Frame(track_frame)
        tree_container.pack(fill=tk.BOTH, expand=True)

        self.track_tree = ttk.Treeview(tree_container, columns=("name",),
                                        show="tree", height=6, selectmode="browse")
        self.track_tree.column("#0", width=0, stretch=False)
        self.track_tree.column("name", width=320)

        scrollbar = ttk.Scrollbar(tree_container, orient=tk.VERTICAL,
                                   command=self.track_tree.yview)
        self.track_tree.configure(yscrollcommand=scrollbar.set)
        self.track_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # 트랙 조작 버튼
        btn_frame = ttk.Frame(track_frame)
        btn_frame.pack(fill=tk.X, pady=(4, 0))

        ttk.Button(btn_frame, text="▲ 위로", width=8, command=self._move_track_up).pack(
            side=tk.LEFT, padx=(0, 2))
        ttk.Button(btn_frame, text="▼ 아래로", width=8, command=self._move_track_down).pack(
            side=tk.LEFT, padx=(0, 2))
        ttk.Button(btn_frame, text="▶ ON AIR", width=10, command=self._on_air_selected).pack(
            side=tk.LEFT, padx=(0, 2))
        ttk.Button(btn_frame, text="✕ 삭제", width=8, command=self._delete_selected).pack(
            side=tk.LEFT, padx=(0, 2))

        btn_frame2 = ttk.Frame(track_frame)
        btn_frame2.pack(fill=tk.X, pady=(2, 0))

        ttk.Button(btn_frame2, text="순서 저장", command=self._save_order).pack(
            side=tk.LEFT, padx=(0, 4))
        ttk.Button(btn_frame2, text="새로고침", command=self._refresh_tracks).pack(
            side=tk.LEFT)

        # ON AIR 상태
        air_frame = ttk.LabelFrame(tab, text="ON AIR 상태", padding=6)
        air_frame.pack(fill=tk.X, pady=(0, 4))

        self.file_status_var = tk.StringVar(value="대기 중")
        ttk.Label(air_frame, textvariable=self.file_status_var,
                  style="OnAir.TLabel").pack(anchor=tk.W)

        air_btn_frame = ttk.Frame(air_frame)
        air_btn_frame.pack(fill=tk.X, pady=(4, 0))

        self.pause_btn = ttk.Button(air_btn_frame, text="⏸ 일시정지",
                                     command=self._toggle_pause, state=tk.DISABLED)
        self.pause_btn.pack(side=tk.LEFT, padx=(0, 4))
        self.stop_air_btn = ttk.Button(air_btn_frame, text="■ 방송 종료",
                                        command=self._stop_file_broadcast, state=tk.DISABLED)
        self.stop_air_btn.pack(side=tk.LEFT)

        # 라이브 잠금 경고
        self.file_lock_var = tk.StringVar(value="")
        self.file_lock_label = ttk.Label(tab, textvariable=self.file_lock_var,
                                          style="Warning.TLabel")
        self.file_lock_label.pack(pady=(2, 0))

        # 선택된 파일 목록 (업로드 대기)
        self.pending_files = []

    # ══════════════════════════════════════════════════════
    # 공통
    # ══════════════════════════════════════════════════════

    def _get_api_client(self):
        """현재 설정으로 ApiClient 생성/갱신"""
        url = self.url_var.get().strip()
        key = self.key_var.get().strip()
        if not url or not key:
            return None
        if (self.api_client is None
                or self.api_client.worker_url != url.rstrip("/")
                or self.api_client.admin_key != key):
            self.api_client = ApiClient(url, key)
        return self.api_client

    def _save_current_settings(self):
        save_settings({
            "worker_url": self.url_var.get().strip(),
            "admin_key": self.key_var.get().strip(),
            "title": self.title_var.get(),
            "mic_device": self.mic_var.get(),
            "sys_device": self.sys_var.get(),
            "mic_vol": self.mic_vol.get(),
            "sys_vol": self.sys_vol.get(),
            "last_tab": self.notebook.index(self.notebook.select()),
        })

    def _on_tab_changed(self, event):
        tab_idx = self.notebook.index(self.notebook.select())
        if tab_idx == 1:  # 파일 방송 탭
            self._refresh_tracks()
            self._start_file_polling()
        else:
            self._stop_file_polling()

    # ══════════════════════════════════════════════════════
    # 라이브 방송 (기존 기능)
    # ══════════════════════════════════════════════════════

    def refresh_devices(self):
        self.devices = list_audio_devices()
        names = ["(사용 안 함)"] + self.devices
        self.mic_combo.configure(values=names)
        self.sys_combo.configure(values=names)

    def toggle_live(self):
        if self.is_broadcasting:
            self.stop_live()
        else:
            self.start_live()

    def start_live(self):
        url = self.url_var.get().strip()
        key = self.key_var.get().strip()
        if not url or not key:
            messagebox.showerror("오류", "Workers URL과 Admin Key를 입력하세요.")
            return

        mic = self.mic_var.get()
        sys_dev = self.sys_var.get()
        if mic == "(사용 안 함)" and sys_dev == "(사용 안 함)":
            messagebox.showerror("오류", "마이크 또는 PC 사운드 중 하나 이상을 선택하세요.")
            return

        # 파일 ON AIR 중이면 경고
        if self.is_file_on_air:
            messagebox.showerror("오류", "파일 방송이 ON AIR 중입니다. 먼저 종료하세요.")
            return

        self._save_current_settings()
        config.WORKER_URL = url
        config.ADMIN_KEY = key

        # Uploader 시작
        self.uploader = Uploader(
            worker_url=url, admin_key=key,
            on_status=lambda s: self.root.after(0, self._on_live_status, s),
            on_error=lambda e: self.root.after(0, self._on_live_error, e),
        )

        title = self.title_var.get().strip()
        if not self.uploader.start_broadcast(title=title, chunk_duration=config.CHUNK_DURATION):
            return

        # AudioEngine 시작
        mic_dev = mic if mic != "(사용 안 함)" else None
        sys_device = sys_dev if sys_dev != "(사용 안 함)" else None

        self.engine = AudioEngine(
            mic_device=mic_dev, system_device=sys_device,
            mic_volume=self.mic_vol.get(), system_volume=self.sys_vol.get(),
            on_chunk=self._on_chunk,
            on_error=lambda e: self.root.after(0, self._on_live_error, e),
        )
        self.engine.start()

        self.is_broadcasting = True
        self.start_time = time.time()
        self.live_start_btn.configure(text="방송 종료")
        self.live_status_var.set("방송 중...")
        self._update_timer()

    def stop_live(self):
        self.is_broadcasting = False

        if self.engine:
            self.engine.stop()
            self.engine = None

        if self.uploader:
            self.uploader.stop_broadcast()
            self.uploader = None

        if self.timer_id:
            self.root.after_cancel(self.timer_id)
            self.timer_id = None

        self.live_start_btn.configure(text="방송 시작")
        self.live_status_var.set("방송 종료")
        self.live_timer_var.set("")
        self.live_chunk_var.set("")

    def _on_chunk(self, chunk_data, chunk_index):
        if self.uploader and self.is_broadcasting:
            self.uploader.upload_chunk(chunk_data, chunk_index)

    def _on_live_status(self, msg):
        self.live_status_var.set(msg)
        if self.uploader:
            self.live_chunk_var.set(
                f"전송: {self.uploader.uploaded_count}청크 | 큐: {self.uploader.queue_size}")

    def _on_live_error(self, msg):
        self.live_status_var.set(f"오류: {msg}")

    def _update_timer(self):
        if not self.is_broadcasting:
            return
        elapsed = int(time.time() - self.start_time)
        h, m, s = elapsed // 3600, (elapsed % 3600) // 60, elapsed % 60
        self.live_timer_var.set(f"{h:02d}:{m:02d}:{s:02d}")
        self.timer_id = self.root.after(1000, self._update_timer)

    # ══════════════════════════════════════════════════════
    # 파일 방송
    # ══════════════════════════════════════════════════════

    def _select_files(self):
        files = filedialog.askopenfilenames(
            title="오디오 파일 선택",
            filetypes=AUDIO_FILETYPES,
        )
        if files:
            self.pending_files = list(files)
            names = [os.path.basename(f) for f in self.pending_files]
            self.upload_info_var.set(f"{len(names)}개 선택")
            self.upload_btn.configure(state=tk.NORMAL)
        else:
            self.pending_files = []
            self.upload_info_var.set("")
            self.upload_btn.configure(state=tk.DISABLED)

    def _upload_files(self):
        if not self.pending_files or self.uploading:
            return

        client = self._get_api_client()
        if not client:
            messagebox.showerror("오류", "Workers URL과 Admin Key를 입력하세요.")
            return

        self.uploading = True
        self.upload_btn.configure(state=tk.DISABLED)
        files = self.pending_files[:]
        self.upload_progress.pack(fill=tk.X, pady=(0, 4))
        self.upload_progress["maximum"] = len(files)
        self.upload_progress["value"] = 0

        def do_upload():
            for i, fpath in enumerate(files):
                name = os.path.splitext(os.path.basename(fpath))[0]
                result = client.upload_file(fpath, name)
                self.root.after(0, self._upload_progress_update, i + 1, len(files),
                                os.path.basename(fpath), result is not None)

            self.root.after(0, self._upload_done)

        threading.Thread(target=do_upload, daemon=True).start()

    def _upload_progress_update(self, current, total, filename, success):
        self.upload_progress["value"] = current
        status = "완료" if success else "실패"
        self.upload_info_var.set(f"[{current}/{total}] {filename} {status}")

    def _upload_done(self):
        self.uploading = False
        self.pending_files = []
        self.upload_btn.configure(state=tk.DISABLED)
        self.upload_progress.pack_forget()
        self.upload_info_var.set("업로드 완료")
        self._refresh_tracks()

    def _refresh_tracks(self):
        client = self._get_api_client()
        if not client:
            return

        def do_refresh():
            tracks = client.get_tracks()
            self.root.after(0, self._update_track_list, tracks)

        threading.Thread(target=do_refresh, daemon=True).start()

    def _update_track_list(self, tracks):
        self.tracks = tracks
        self.track_tree.delete(*self.track_tree.get_children())
        on_air_key = self.ch5_state.get("trackKey")
        for t in tracks:
            prefix = "♪ " if t.get("key") == on_air_key else ""
            self.track_tree.insert("", tk.END, iid=t["key"],
                                    values=(prefix + t.get("name", t["key"]),))

    def _get_selected_track(self):
        sel = self.track_tree.selection()
        if not sel:
            messagebox.showinfo("알림", "트랙을 선택하세요.")
            return None
        key = sel[0]
        for t in self.tracks:
            if t["key"] == key:
                return t
        return None

    def _move_track_up(self):
        sel = self.track_tree.selection()
        if not sel:
            return
        items = list(self.track_tree.get_children())
        idx = items.index(sel[0])
        if idx > 0:
            # 트랙 데이터 스왑
            self.tracks[idx], self.tracks[idx - 1] = self.tracks[idx - 1], self.tracks[idx]
            self._update_track_list(self.tracks)
            self.track_tree.selection_set(sel[0])
            self.track_tree.see(sel[0])

    def _move_track_down(self):
        sel = self.track_tree.selection()
        if not sel:
            return
        items = list(self.track_tree.get_children())
        idx = items.index(sel[0])
        if idx < len(items) - 1:
            self.tracks[idx], self.tracks[idx + 1] = self.tracks[idx + 1], self.tracks[idx]
            self._update_track_list(self.tracks)
            self.track_tree.selection_set(sel[0])
            self.track_tree.see(sel[0])

    def _save_order(self):
        client = self._get_api_client()
        if not client:
            return
        ordered = []
        for i, t in enumerate(self.tracks):
            ordered.append({"key": t["key"], "name": t.get("name", ""), "order": i})

        def do_save():
            ok = client.save_order(ordered)
            self.root.after(0, lambda: self.upload_info_var.set(
                "순서 저장 완료" if ok else "순서 저장 실패"))

        threading.Thread(target=do_save, daemon=True).start()

    def _on_air_selected(self):
        track = self._get_selected_track()
        if not track:
            return

        if self.is_broadcasting:
            messagebox.showerror("오류", "라이브 방송 중에는 파일 ON AIR를 사용할 수 없습니다.")
            return

        client = self._get_api_client()
        if not client:
            messagebox.showerror("오류", "Workers URL과 Admin Key를 입력하세요.")
            return

        self.upload_info_var.set("재생시간 확인 중...")

        def do_on_air():
            # ffprobe로 duration을 구할 수 없으므로 서버의 스트리밍 URL로 시도
            # 대신 duration=0 전송 (서버에서 처리)
            duration = 0
            ok, err = client.go_on_air(track["key"], track.get("name", ""), duration)
            self.root.after(0, self._on_air_result, ok, err, track)

        threading.Thread(target=do_on_air, daemon=True).start()

    def _on_air_result(self, ok, err, track):
        self.upload_info_var.set("")
        if ok:
            self.is_file_on_air = True
            self.file_status_var.set(f"ON AIR: {track.get('name', '')}")
            self.pause_btn.configure(state=tk.NORMAL, text="⏸ 일시정지")
            self.stop_air_btn.configure(state=tk.NORMAL)
            self._refresh_tracks()
        else:
            messagebox.showerror("ON AIR 실패", err or "알 수 없는 오류")

    def _toggle_pause(self):
        client = self._get_api_client()
        if not client:
            return

        state = self.ch5_state
        is_paused = not state.get("paused", False)

        def do_toggle():
            ok = client.toggle_pause(
                track_key=state.get("trackKey"),
                track_name=state.get("trackName", ""),
                duration=state.get("duration", 0),
                paused=is_paused,
                current_time=0,
                start_epoch=state.get("startEpoch"),
            )
            self.root.after(0, self._toggle_pause_result, ok, is_paused)

        threading.Thread(target=do_toggle, daemon=True).start()

    def _toggle_pause_result(self, ok, is_paused):
        if ok:
            self.pause_btn.configure(text="▶ 재개" if is_paused else "⏸ 일시정지")
            status_prefix = "일시정지: " if is_paused else "ON AIR: "
            self.file_status_var.set(status_prefix + self.ch5_state.get("trackName", ""))

    def _stop_file_broadcast(self):
        if not messagebox.askyesno("확인", "파일 방송을 종료하시겠습니까?"):
            return

        client = self._get_api_client()
        if not client:
            return

        def do_stop():
            ok = client.stop_file_broadcast()
            self.root.after(0, self._stop_file_result, ok)

        threading.Thread(target=do_stop, daemon=True).start()

    def _stop_file_result(self, ok):
        if ok:
            self.is_file_on_air = False
            self.file_status_var.set("방송 종료")
            self.pause_btn.configure(state=tk.DISABLED)
            self.stop_air_btn.configure(state=tk.DISABLED)
            self._refresh_tracks()

    def _delete_selected(self):
        track = self._get_selected_track()
        if not track:
            return

        if not messagebox.askyesno("삭제 확인", f"'{track.get('name', '')}' 트랙을 삭제하시겠습니까?"):
            return

        client = self._get_api_client()
        if not client:
            return

        def do_delete():
            ok = client.delete_track(track["key"])
            self.root.after(0, lambda: (
                self.upload_info_var.set("삭제 완료" if ok else "삭제 실패"),
                self._refresh_tracks() if ok else None,
            ))

        threading.Thread(target=do_delete, daemon=True).start()

    # ── 파일 방송 상태 폴링 ─────────────────────────────

    def _start_file_polling(self):
        self._stop_file_polling()
        self._poll_file_state()

    def _stop_file_polling(self):
        if self.file_poll_id:
            self.root.after_cancel(self.file_poll_id)
            self.file_poll_id = None

    def _poll_file_state(self):
        client = self._get_api_client()
        if not client:
            self.file_poll_id = self.root.after(5000, self._poll_file_state)
            return

        def do_poll():
            ch5 = client.get_ch5_state()
            live = client.get_live_state()
            self.root.after(0, self._update_file_state, ch5, live)

        threading.Thread(target=do_poll, daemon=True).start()

    def _update_file_state(self, ch5_state, live_state):
        self.ch5_state = ch5_state
        track_key = ch5_state.get("trackKey")
        paused = ch5_state.get("paused", True)
        live_active = live_state.get("active", False)

        if track_key and not paused:
            self.is_file_on_air = True
            self.file_status_var.set(f"ON AIR: {ch5_state.get('trackName', '')}")
            self.pause_btn.configure(state=tk.NORMAL, text="⏸ 일시정지")
            self.stop_air_btn.configure(state=tk.NORMAL)
        elif track_key and paused:
            self.is_file_on_air = True
            self.file_status_var.set(f"일시정지: {ch5_state.get('trackName', '')}")
            self.pause_btn.configure(state=tk.NORMAL, text="▶ 재개")
            self.stop_air_btn.configure(state=tk.NORMAL)
        else:
            self.is_file_on_air = False
            self.file_status_var.set("대기 중")
            self.pause_btn.configure(state=tk.DISABLED)
            self.stop_air_btn.configure(state=tk.DISABLED)

        # 라이브 잠금 표시
        if live_active:
            self.file_lock_var.set("라이브 방송 진행 중 — 파일 ON AIR 불가")
        else:
            self.file_lock_var.set("")

        # 라이브 탭에도 파일 ON AIR 잠금 표시
        if self.is_file_on_air:
            self.live_lock_var.set("파일 ON AIR 중 — 라이브 방송 시작 불가")
        else:
            self.live_lock_var.set("")

        # 트랙 목록 갱신 (ON AIR 표시 업데이트)
        self._update_track_list(self.tracks)

        # 다음 폴링
        self.file_poll_id = self.root.after(5000, self._poll_file_state)

    # ══════════════════════════════════════════════════════
    # 종료
    # ══════════════════════════════════════════════════════

    def on_close(self):
        if self.is_broadcasting:
            if messagebox.askyesno("확인", "라이브 방송 중입니다. 종료하시겠습니까?"):
                self.stop_live()
            else:
                return

        self._stop_file_polling()
        self._save_current_settings()
        self.root.destroy()


def ensure_single_instance():
    """이미 실행 중이면 기존 창을 포그라운드로 올리고 종료"""
    mutex_name = "Global\\BomSoriHost_SingleInstance"
    kernel32 = ctypes.windll.kernel32
    mutex = kernel32.CreateMutexW(None, False, mutex_name)
    if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        user32 = ctypes.windll.user32
        hwnd = user32.FindWindowW(None, config.WINDOW_TITLE)
        if hwnd:
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
        sys.exit(0)
    return mutex


def main():
    mutex = ensure_single_instance()
    root = tk.Tk()
    HostApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
