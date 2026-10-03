import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

const TOKEN_KEY = "coldchain_token";
const USER_KEY = "coldchain_user";
const POLL_MS = 3000;
const LIMIT_CHOICES = [5, 10, 20, 30];

function verdictClass(v, status) {
  if (v === "合格") return "tag pass";
  if (v === "超温") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  });
  const hash = useHashRoute();

  const authHeaders = useCallback(() => {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  if (!token) {
    return <Login setToken={setToken} setUser={setUser} />;
  }

  const isWriter = user?.role === "writer";
  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  };

  const route = hash.replace(/^#/, "") || "/";
  const snapMatch = route.match(/^\/snapshot\/(\d+)$/);

  let view = <HomeView authHeaders={authHeaders} />;
  if (route === "/comparison") {
    view = <ComparisonOnline authHeaders={authHeaders} isWriter={isWriter} username={user?.username} />;
  } else if (snapMatch) {
    view = <SnapshotView authHeaders={authHeaders} snapshotId={Number(snapMatch[1])} isWriter={isWriter} />;
  }

  return (
    <div class="wrap">
      <div class="topbar">
        <div>
          <h1>冷链探头超温台</h1>
          <p class="sub">温度不超过 8℃ 为合格，否则为超温。</p>
        </div>
        <div class="user">
          <nav class="nav">
            <a class={route === "/" ? "active" : ""} href="#/">总览</a>
            <a class={route.startsWith("/comparison") || snapMatch ? "active" : ""} href="#/comparison">
              温度对照
            </a>
          </nav>
          {user?.username}（{isWriter ? "记录员" : "值班员"}）
          <button type="button" class="secondary" style={{ marginLeft: "0.5rem" }} onClick={logout}>
            退出
          </button>
        </div>
      </div>
      {view}
    </div>
  );
}

function Login({ setToken, setUser }) {
  const [loginForm, setLoginForm] = useState({ username: "logger", password: "log123456" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onLogin(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm),
      });
      if (!res.ok) {
        setError("用户名或密码错误");
        return;
      }
      const data = await res.json();
      localStorage.setItem(TOKEN_KEY, data.access_token);
      localStorage.setItem(USER_KEY, JSON.stringify({ username: data.username, role: data.role }));
      setToken(data.access_token);
      setUser({ username: data.username, role: data.role });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class="wrap">
      <h1>冷链探头超温台</h1>
      <p class="sub">记录员提交探头编号与摄氏温度，后台工人认领后判定合格或超温。</p>
      <div class="card">
        <form onSubmit={onLogin}>
          <div class="row">
            <label>
              用户名
              <input
                value={loginForm.username}
                onInput={(e) => setLoginForm({ ...loginForm, username: e.target.value })}
              />
            </label>
            <label>
              密码
              <input
                type="password"
                value={loginForm.password}
                onInput={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
              />
            </label>
            <button type="submit" disabled={loading}>
              登录
            </button>
          </div>
          {error && <p class="err">{error}</p>}
        </form>
        <p class="sub" style={{ marginBottom: 0 }}>
          记录员 logger / log123456 · 值班员 watcher / watch123456
        </p>
      </div>
    </div>
  );
}

function HomeView({ authHeaders }) {
  const [submitForm, setSubmitForm] = useState({ probe_id: "", temp_c: "" });
  const [rows, setRows] = useState([]);
  const [user] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  });
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const isWriter = user?.role === "writer";

  const loadReadings = useCallback(async () => {
    const res = await fetch("/api/readings", { headers: authHeaders() });
    if (!res.ok) return;
    setRows(await res.json());
  }, [authHeaders]);

  useEffect(() => {
    loadReadings();
    const t = setInterval(loadReadings, POLL_MS);
    return () => clearInterval(t);
  }, [loadReadings]);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setMsg("");
    setLoading(true);
    try {
      const res = await fetch("/api/readings", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          probe_id: submitForm.probe_id,
          temp_c: parseFloat(submitForm.temp_c),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || "提交失败");
        return;
      }
      setMsg(data.message || "已提交");
      setSubmitForm({ probe_id: "", temp_c: "" });
      await loadReadings();
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {isWriter && (
        <div class="card">
          <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>提交读数</h2>
          <form onSubmit={onSubmit}>
            <div class="row">
              <label>
                探头编号
                <input
                  required
                  value={submitForm.probe_id}
                  onInput={(e) => setSubmitForm({ ...submitForm, probe_id: e.target.value })}
                  placeholder="例如 探头C03"
                />
              </label>
              <label>
                温度（℃）
                <input
                  required
                  type="number"
                  step="0.1"
                  value={submitForm.temp_c}
                  onInput={(e) => setSubmitForm({ ...submitForm, temp_c: e.target.value })}
                />
              </label>
              <button type="submit" disabled={loading}>
                提交
              </button>
            </div>
            {error && <p class="err">{error}</p>}
            {msg && <p class="ok">{msg}</p>}
          </form>
        </div>
      )}

      <div class="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>读数列表（按办结先后）</h2>
        <table>
          <thead>
            <tr>
              <th>编号</th>
              <th>探头</th>
              <th>温度℃</th>
              <th>结论</th>
              <th>说明</th>
              <th>状态</th>
              <th>提交人</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.probe_id}</td>
                <td>{r.temp_c}</td>
                <td>
                  <span class={verdictClass(r.verdict, r.status)}>{displayVerdict(r)}</span>
                </td>
                <td>{r.reason || "—"}</td>
                <td>{r.status}</td>
                <td>{r.created_by}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colspan="7">暂无数据</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PointsTable({ points, baseId, otherId, onPick, highlightIds = [] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>办结序</th>
          <th>编号</th>
          <th>探头</th>
          <th>温度℃</th>
          <th>结论</th>
          {onPick && (
            <>
              <th>基准点</th>
              <th>对照点</th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {points.map((p, idx) => {
          const hl = highlightIds.includes(p.id);
          return (
            <tr key={p.id} class={hl ? "row-hl" : ""}>
              <td>{idx + 1}</td>
              <td>{p.id}</td>
              <td>{p.probe_id}</td>
              <td>{p.temp_c}</td>
              <td>
                <span class={verdictClass(p.verdict, p.status)}>{displayVerdict(p)}</span>
              </td>
              {onPick && (
                <>
                  <td>
                    <input
                      type="radio"
                      name="base-point"
                      checked={baseId === p.id}
                      onChange={() => onPick("base", p.id)}
                    />
                  </td>
                  <td>
                    <input
                      type="radio"
                      name="other-point"
                      checked={otherId === p.id}
                      onChange={() => onPick("other", p.id)}
                    />
                  </td>
                </>
              )}
            </tr>
          );
        })}
        {points.length === 0 && (
          <tr>
            <td colspan={onPick ? 7 : 5}>暂无已办结点</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function DiffCard({ diff, loading, error, frozen = false }) {
  return (
    <div class="card side-card">
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>
        {frozen ? "差值（锁定时冻结）" : "差值（服务端计算）"}
      </h2>
      {error && <p class="err">{error}</p>}
      {loading && <p class="sub">正在向服务端取差值…</p>}
      {!loading && !diff && !error && <p class="sub">在点表中选择一个基准点和一个对照点。</p>}
      {!loading && diff && (
        <div>
          <p class="diff-line">
            <span class="diff-name">
              {diff.base.probe_id}（#{diff.base.id}，{diff.base.temp_c}℃）
            </span>
            {" 减 "}
            <span class="diff-name">
              {diff.other.probe_id}（#{diff.other.id}，{diff.other.temp_c}℃）
            </span>
          </p>
          <p class="diff-value">差值 {diff.diff_c > 0 ? "+" : ""}{diff.diff_c}℃</p>
          <p class="sub" style={{ marginBottom: 0 }}>
            {frozen
              ? "此差值为锁定瞬间的服务端结果，随后不再变化。"
              : "差值由服务端按库中温度算出，页面不做相减。"}
          </p>
        </div>
      )}
    </div>
  );
}

function LockedList({ snapshots }) {
  return (
    <div class="card side-card">
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>已锁副本</h2>
      {snapshots.length === 0 && <p class="sub" style={{ marginBottom: 0 }}>暂无锁定副本。</p>}
      <ul class="snap-list">
        {snapshots.map((s) => (
          <li key={s.id}>
            <a href={`#/snapshot/${s.id}`}>
              副本 #{s.id}：{s.base_probe_id} − {s.other_probe_id}，差值 {s.diff_c}℃
            </a>
            <span class="snap-meta">
              {s.locked_by} · {formatTime(s.locked_at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ComparisonOnline({ authHeaders, isWriter, username }) {
  const [limit, setLimit] = useState(10);
  const [points, setPoints] = useState([]);
  const [baseId, setBaseId] = useState(null);
  const [otherId, setOtherId] = useState(null);
  const [diff, setDiff] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [snapshots, setSnapshots] = useState([]);
  const [lockError, setLockError] = useState("");
  const [locking, setLocking] = useState(false);

  const loadPoints = useCallback(async () => {
    const res = await fetch(`/api/comparison/points?limit=${limit}`, { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      setPoints(data.points);
      setBaseId((b) => (b != null && !data.points.some((p) => p.id === b) ? null : b));
      setOtherId((o) => (o != null && !data.points.some((p) => p.id === o) ? null : o));
    }
  }, [authHeaders, limit]);

  const loadSnapshots = useCallback(async () => {
    const res = await fetch("/api/comparison/snapshots", { headers: authHeaders() });
    if (res.ok) setSnapshots(await res.json());
  }, [authHeaders]);

  useEffect(() => {
    loadPoints();
    const t = setInterval(loadPoints, POLL_MS);
    return () => clearInterval(t);
  }, [loadPoints]);

  useEffect(() => {
    loadSnapshots();
    const t = setInterval(loadSnapshots, POLL_MS);
    return () => clearInterval(t);
  }, [loadSnapshots]);

  // 选满两点即交给服务端算差值；页面本身绝不相减
  useEffect(() => {
    if (baseId == null || otherId == null) {
      setDiff(null);
      setDiffError("");
      return;
    }
    if (baseId === otherId) {
      setDiff(null);
      setDiffError("基准点与对照点不能是同一个点");
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError("");
    (async () => {
      try {
        const res = await fetch("/api/comparison/diff", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ base_id: baseId, other_id: otherId }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setDiff(null);
          setDiffError(data.detail || "取差值失败");
        } else {
          setDiff(data);
        }
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseId, otherId, authHeaders]);

  function onPick(kind, id) {
    setLockError("");
    if (kind === "base") {
      setBaseId(id);
      if (otherId === id) setOtherId(null);
    } else {
      setOtherId(id);
      if (baseId === id) setBaseId(null);
    }
  }

  async function lockSnapshot() {
    if (!diff) return;
    setLocking(true);
    setLockError("");
    try {
      const res = await fetch("/api/comparison/snapshots", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ base_id: baseId, other_id: otherId, limit }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLockError(data.detail || "锁定副本失败");
        return;
      }
      await loadSnapshots();
      window.location.hash = `#/snapshot/${data.id}`;
    } finally {
      setLocking(false);
    }
  }

  return (
    <>
      <div class="card">
        <div class="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>温度对照（近次已办结，按办结先后）</h2>
          <label style={{ flexDirection: "row", alignItems: "center", gap: "0.4rem" }}>
            条数
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {LIMIT_CHOICES.map((n) => (
                <option value={n}>近 {n} 条</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div class="cmp-grid">
        <div class="card cmp-main">
          <PointsTable points={points} baseId={baseId} otherId={otherId} onPick={onPick} />
        </div>
        <div class="cmp-side">
          <DiffCard diff={diff} loading={diffLoading} error={diffError} />
          <div class="card side-card">
            <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>锁副本</h2>
            {isWriter ? (
              <>
                <p class="sub" style={{ marginTop: 0 }}>
                  锁定后点集与差值即刻冻结；之后新办结只更新在线点表，此副本不再变化。
                </p>
                <button type="button" disabled={!diff || locking} onClick={lockSnapshot}>
                  锁定当前对照为副本
                </button>
                {lockError && <p class="err">{lockError}</p>}
              </>
            ) : (
              <p class="sub" style={{ marginBottom: 0 }}>
                当前以值班员 {username} 登录：可查看温度对照与已锁副本，仅记录员可锁定副本。
              </p>
            )}
          </div>
          <LockedList snapshots={snapshots} />
        </div>
      </div>
    </>
  );
}

function SnapshotView({ authHeaders, snapshotId, isWriter }) {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSnap(null);
    setError("");
    (async () => {
      const res = await fetch(`/api/comparison/snapshots/${snapshotId}`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!res.ok) setError(data.detail || "副本加载失败");
      else setSnap(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [authHeaders, snapshotId]);

  const frozenDiff = useMemo(() => {
    if (!snap) return null;
    const base = snap.points.find((p) => p.id === snap.base_point_id);
    const other = snap.points.find((p) => p.id === snap.other_point_id);
    if (!base || !other) return null;
    return { base, other, diff_c: snap.diff_c };
  }, [snap]);

  return (
    <>
      <div class="card locked-banner">
        <div class="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.1rem" }}>已锁副本 #{snapshotId}（冻结）</h2>
            <p class="sub" style={{ margin: "0.5rem 0 0" }}>
              {snap ? `锁定人 ${snap.locked_by} · 锁定时间 ${formatTime(snap.locked_at)}` : "加载中…"}
              ，新办结不影响本副本。
            </p>
          </div>
          <a class="backlink" href="#/comparison">
            ← 返回在线对照
          </a>
        </div>
      </div>

      {error && (
        <div class="card">
          <p class="err">{error}</p>
        </div>
      )}

      {snap && (
        <div class="cmp-grid">
          <div class="card cmp-main">
            <PointsTable
              points={snap.points}
              baseId={snap.base_point_id}
              otherId={snap.other_point_id}
              highlightIds={[snap.base_point_id, snap.other_point_id]}
            />
          </div>
          <div class="cmp-side">
            {frozenDiff ? (
              <DiffCard diff={frozenDiff} loading={false} error="" frozen />
            ) : (
              <div class="card side-card">
                <p class="sub" style={{ marginBottom: 0 }}>锁定时所选两点的记录已不在副本点集中。</p>
              </div>
            )}
            <div class="card side-card">
              <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>副本状态</h2>
              <p class="sub" style={{ marginBottom: 0 }}>
                此页停留在锁定时的点集与差值，不随新办结刷新。{isWriter ? "记录员" : "值班员"}可查看，副本不可更改。
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
