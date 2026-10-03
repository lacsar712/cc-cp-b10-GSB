import { useCallback, useEffect, useState } from "preact/hooks";

const TOKEN_KEY = "coldchain_token";
const USER_KEY = "coldchain_user";
const LIMIT_OPTIONS = [5, 10, 20, 50];

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

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtTemp(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(2)));
}

function fmtDiff(v) {
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${parseFloat(n.toFixed(2))}℃`;
}

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  if (hash.startsWith("#/comparison/snapshot/")) {
    const id = Number(hash.slice("#/comparison/snapshot/".length));
    return { name: "snapshot", id };
  }
  if (hash.startsWith("#/comparison")) return { name: "comparison" };
  return { name: "home" };
}

function nav(name) {
  window.location.hash = name === "comparison" ? "#/comparison" : "#/";
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
  const route = useHashRoute();

  const authHeaders = useCallback(() => {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
    window.location.hash = "#/";
  }

  if (!token) {
    return <Login onAuthed={(t, u) => {
      setToken(t);
      setUser(u);
    }} />;
  }

  const isWriter = user?.role === "writer";

  return (
    <div class="wrap">
      <div class="topbar">
        <div>
          <h1>冷链探头超温台</h1>
          <p class="sub" style={{ marginBottom: 0 }}>
            温度不超过 8℃ 为合格，否则为超温。
          </p>
        </div>
        <div class="topright">
          <nav class="nav">
            <button
              type="button"
              class={route.name === "home" ? "navbtn active" : "navbtn"}
              onClick={() => nav("home")}
            >
              总览
            </button>
            <button
              type="button"
              class={
                route.name === "comparison" || route.name === "snapshot"
                  ? "navbtn active"
                  : "navbtn"
              }
              onClick={() => nav("comparison")}
            >
              温度对照
            </button>
          </nav>
          <div class="user">
            {user?.username}（{isWriter ? "记录员" : "值班员"}）
            <button
              type="button"
              class="secondary"
              style={{ marginLeft: "0.5rem" }}
              onClick={logout}
            >
              退出
            </button>
          </div>
        </div>
      </div>

      {route.name === "home" && (
        <HomeView isWriter={isWriter} authHeaders={authHeaders} />
      )}
      {route.name === "comparison" && (
        <ComparisonMain isWriter={isWriter} authHeaders={authHeaders} />
      )}
      {route.name === "snapshot" && (
        <SnapshotView snapshotId={route.id} isWriter={isWriter} authHeaders={authHeaders} />
      )}
    </div>
  );
}

function Login({ onAuthed }) {
  const [loginForm, setLoginForm] = useState({
    username: "logger",
    password: "log123456",
  });
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
      localStorage.setItem(
        USER_KEY,
        JSON.stringify({ username: data.username, role: data.role })
      );
      onAuthed(data.access_token, {
        username: data.username,
        role: data.role,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class="wrap">
      <h1>冷链探头超温台</h1>
      <p class="sub">
        记录员提交探头编号与摄氏温度，后台工人认领后判定合格或超温。
      </p>
      <div class="card">
        <form onSubmit={onLogin}>
          <div class="row">
            <label>
              用户名
              <input
                value={loginForm.username}
                onInput={(e) =>
                  setLoginForm({ ...loginForm, username: e.target.value })
                }
              />
            </label>
            <label>
              密码
              <input
                type="password"
                value={loginForm.password}
                onInput={(e) =>
                  setLoginForm({ ...loginForm, password: e.target.value })
                }
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

function HomeView({ isWriter, authHeaders }) {
  const [submitForm, setSubmitForm] = useState({ probe_id: "", temp_c: "" });
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const loadReadings = useCallback(async () => {
    const res = await fetch("/api/readings", { headers: authHeaders() });
    if (!res.ok) {
      setError("加载列表失败，请重新登录");
      return;
    }
    setRows(await res.json());
  }, [authHeaders]);

  useEffect(() => {
    loadReadings();
    const t = setInterval(loadReadings, 3000);
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
                  onInput={(e) =>
                    setSubmitForm({ ...submitForm, probe_id: e.target.value })
                  }
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
                  onInput={(e) =>
                    setSubmitForm({ ...submitForm, temp_c: e.target.value })
                  }
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
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>
          读数列表
          <span class="hint">（按办结先后，待处理排末尾）</span>
        </h2>
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
              <th>办结时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.probe_id}</td>
                <td>{fmtTemp(r.temp_c)}</td>
                <td>
                  <span class={verdictClass(r.verdict, r.status)}>
                    {displayVerdict(r)}
                  </span>
                </td>
                <td>{r.reason || "—"}</td>
                <td>{r.status}</td>
                <td>{r.created_by}</td>
                <td class="nowrap">{fmtTime(r.processed_at)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colspan="8">暂无数据</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ComparisonMain({ isWriter, authHeaders }) {
  const [limit, setLimit] = useState(10);
  const [overview, setOverview] = useState(null);
  // 选中的两个点：[基准点 id, 对照点 id]，按勾选先后
  const [selected, setSelected] = useState([]);
  const [currentDiff, setCurrentDiff] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadOverview = useCallback(async () => {
    const res = await fetch(`/api/comparison?limit=${limit}`, {
      headers: authHeaders(),
    });
    if (res.status === 401) return;
    if (!res.ok) {
      setError("加载对照数据失败");
      return;
    }
    const data = await res.json();
    setOverview(data);
  }, [authHeaders, limit]);

  // 新办结把已选点挤出近 N 条窗口时，自动取消勾选并清掉旧差值
  useEffect(() => {
    if (!overview) return;
    const ids = new Set(overview.points.map((p) => p.id));
    if (selected.some((id) => !ids.has(id))) {
      setSelected(selected.filter((id) => ids.has(id)));
      setCurrentDiff(null);
    }
    // 只在对照数据刷新时处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview]);

  useEffect(() => {
    loadOverview();
    const t = setInterval(loadOverview, 3000);
    return () => clearInterval(t);
  }, [loadOverview]);

  function togglePoint(id) {
    setError("");
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
    setCurrentDiff(null);
  }

  // 选满两点即自动交服务端计算，浏览器自身从不相减
  useEffect(() => {
    if (selected.length === 2) askDiff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function askDiff() {
    if (selected.length !== 2) return;
    setError("");
    setBusy(true);
    try {
      const [base_reading_id, target_reading_id] = selected;
      const res = await fetch("/api/comparison/diffs", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ base_reading_id, target_reading_id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || "差值计算失败");
        return;
      }
      setCurrentDiff(data);
      await loadOverview();
    } finally {
      setBusy(false);
    }
  }

  async function lockSnapshot() {
    setError("");
    setBusy(true);
    try {
      const payload = { limit };
      if (selected.length === 2) {
        payload.base_reading_id = selected[0];
        payload.target_reading_id = selected[1];
      }
      const res = await fetch("/api/comparison/snapshots", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || "锁定副本失败");
        return;
      }
      // 打开刚锁定的冻结副本；在线点表继续在后台更新，不影响它
      window.location.hash = `#/comparison/snapshot/${data.id}`;
    } finally {
      setBusy(false);
    }
  }

  const points = overview?.points ?? [];
  const byId = new Map(points.map((p) => [p.id, p]));

  return (
    <>
      <div class="card">
        <div class="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>
            近次温度对照
            <span class="hint">（点序与总览办结序一致）</span>
          </h2>
          <label style={{ flexDirection: "row", alignItems: "center", gap: "0.4rem" }}>
            条数
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {LIMIT_OPTIONS.map((n) => (
                <option value={n}>近 {n} 条</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div class="cmp-grid">
        <div class="card">
          <h3 class="panel-title">近次办结点（勾选两点）</h3>
          <table>
            <thead>
              <tr>
                <th class="ck-col">选</th>
                <th>序</th>
                <th>编号</th>
                <th>探头</th>
                <th>温度℃</th>
                <th>结论</th>
                <th>办结时间</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => {
                const selIdx = selected.indexOf(p.id);
                return (
                  <tr key={p.id} class={selIdx >= 0 ? "rowpick" : ""}>
                    <td>
                      <input
                        type="checkbox"
                        class="ck"
                        checked={selIdx >= 0}
                        onChange={() => togglePoint(p.id)}
                      />
                    </td>
                    <td>{i + 1}</td>
                    <td>{p.id}</td>
                    <td>{p.probe_id}</td>
                    <td>{fmtTemp(p.temp_c)}</td>
                    <td>
                      <span class={verdictClass(p.verdict, p.status)}>
                        {p.verdict || "—"}
                      </span>
                    </td>
                    <td class="nowrap">{fmtTime(p.processed_at)}</td>
                  </tr>
                );
              })}
              {points.length === 0 && (
                <tr>
                  <td colspan="7" class="empty">
                    暂无已办结读数
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p class="hint" style={{ marginBottom: 0 }}>
            先勾为基准点、后勾为对照点，满两点后再勾会自动替换对照点。
          </p>
        </div>

        <div class="side">
          <div class="card">
            <h3 class="panel-title">差值（服务端计算）</h3>
            <div class="pickline">
              <span>
                基准点：
                {selected[0] !== undefined
                  ? `#${selected[0]} ${byId.get(selected[0])?.probe_id ?? ""} ${
                      byId.get(selected[0]) !== undefined
                        ? fmtTemp(byId.get(selected[0]).temp_c) + "℃"
                        : ""
                    }`
                  : "未选"}
              </span>
            </div>
            <div class="pickline">
              <span>
                对照点：
                {selected[1] !== undefined
                  ? `#${selected[1]} ${byId.get(selected[1])?.probe_id ?? ""} ${
                      byId.get(selected[1]) !== undefined
                        ? fmtTemp(byId.get(selected[1]).temp_c) + "℃"
                        : ""
                    }`
                  : "未选"}
              </span>
            </div>
            <div class="row" style={{ marginTop: "0.6rem" }}>
              <button
                type="button"
                disabled={selected.length !== 2 || busy}
                onClick={askDiff}
              >
                交服务端算差值
              </button>
              {isWriter ? (
                <button type="button" class="lockbtn" disabled={busy || points.length === 0} onClick={lockSnapshot}>
                  锁定副本
                </button>
              ) : (
                <span class="hint">值班侧仅可查看对照，不能锁定副本</span>
              )}
            </div>
            {currentDiff && (
              <div class="diffbox">
                <div class="diffbig">{fmtDiff(currentDiff.diff_c)}</div>
                <div class="hint">
                  #{currentDiff.target_reading_id} − #{currentDiff.base_reading_id}
                  ，由服务端计算
                </div>
              </div>
            )}
            {error && <p class="err">{error}</p>}

            <h4 class="list-title">最近差值记录</h4>
            <ul class="reclist">
              {(overview?.diffs ?? []).map((d) => (
                <li key={d.id}>
                  <span class="nowrap">
                    #{d.base_reading_id}（{fmtTemp(d.base_temp_c)}℃）→ #
                    {d.target_reading_id}（{fmtTemp(d.target_temp_c)}℃）
                  </span>
                  <strong>{fmtDiff(d.diff_c)}</strong>
                  <span class="hint nowrap">{fmtTime(d.created_at)}</span>
                </li>
              ))}
              {(overview?.diffs ?? []).length === 0 && (
                <li class="hint">暂无差值记录</li>
              )}
            </ul>
          </div>

          <div class="card">
            <h3 class="panel-title">已锁副本（冻结）</h3>
            <ul class="reclist snaplist">
              {(overview?.snapshots ?? []).map((s) => (
                <li key={s.id}>
                  <a href={`#/comparison/snapshot/${s.id}`} class="snaplink">
                    副本 #{s.id}
                  </a>
                  <span class="hint nowrap">
                    近 {s.point_limit} 条 · {s.point_count} 点 · {s.locked_by} 锁于{" "}
                    {fmtTime(s.locked_at)}
                  </span>
                  <span>
                    {s.diff_c !== null && s.diff_c !== undefined
                      ? fmtDiff(s.diff_c)
                      : "未带差值"}
                  </span>
                </li>
              ))}
              {(overview?.snapshots ?? []).length === 0 && (
                <li class="hint">尚无锁定副本</li>
              )}
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}

function SnapshotView({ snapshotId, isWriter, authHeaders }) {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState("");

  const loadSnap = useCallback(async () => {
    const res = await fetch(`/api/comparison/snapshots/${snapshotId}`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.detail || "副本不存在");
      return;
    }
    // 只在打开时取一次：旧副本永远停在锁定时
    setSnap(await res.json());
  }, [authHeaders, snapshotId]);

  useEffect(() => {
    setSnap(null);
    setError("");
  }, [snapshotId]);

  useEffect(() => {
    loadSnap();
  }, [loadSnap]);

  if (error) {
    return (
      <div class="card">
        <p class="err">{error}</p>
        <a href="#/comparison" class="backlink">返回温度对照</a>
      </div>
    );
  }
  if (!snap) return <div class="card">副本加载中…</div>;

  const pointById = new Map(snap.points.map((p) => [p.reading_id, p]));
  const base = snap.base_reading_id ? pointById.get(snap.base_reading_id) : null;
  const target = snap.target_reading_id ? pointById.get(snap.target_reading_id) : null;

  return (
    <>
      <div class="card frozen-banner">
        <div>
          <span class="tag frozen">已锁定副本 #{snap.id}</span>
          <span class="hint" style={{ marginLeft: "0.6rem" }}>
            近 {snap.point_limit} 条 · {snap.points.length} 点 · {snap.locked_by}{" "}
            锁于 {fmtTime(snap.locked_at)}
          </span>
        </div>
        <a href="#/comparison" class="backlink">
          返回在线对照
        </a>
      </div>

      <div class="cmp-grid">
        <div class="card">
          <h3 class="panel-title">冻结点集（锁定时办结序）</h3>
          <table>
            <thead>
              <tr>
                <th>序</th>
                <th>编号</th>
                <th>探头</th>
                <th>温度℃</th>
                <th>结论</th>
                <th>办结时间</th>
              </tr>
            </thead>
            <tbody>
              {snap.points.map((p) => (
                <tr
                  key={p.reading_id}
                  class={
                    p.reading_id === snap.base_reading_id ||
                    p.reading_id === snap.target_reading_id
                      ? "rowpick"
                      : ""
                  }
                >
                  <td>{p.rank}</td>
                  <td>
                    {p.reading_id}
                    {p.reading_id === snap.base_reading_id && (
                      <span class="mini-tag">基准</span>
                    )}
                    {p.reading_id === snap.target_reading_id && (
                      <span class="mini-tag">对照</span>
                    )}
                  </td>
                  <td>{p.probe_id}</td>
                  <td>{fmtTemp(p.temp_c)}</td>
                  <td>
                    <span class={verdictClass(p.verdict, "done")}>{p.verdict}</span>
                  </td>
                  <td class="nowrap">{fmtTime(p.processed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div class="side">
          <div class="card">
            <h3 class="panel-title">冻结差值</h3>
            {snap.diff_c !== null && snap.diff_c !== undefined ? (
              <div class="diffbox">
                <div class="diffbig">{fmtDiff(snap.diff_c)}</div>
                <div class="hint">
                  #{snap.target_reading_id}
                  {target ? `（${target.probe_id} ${fmtTemp(target.temp_c)}℃）` : ""} −
                  #{snap.base_reading_id}
                  {base ? `（${base.probe_id} ${fmtTemp(base.temp_c)}℃）` : ""}
                </div>
              </div>
            ) : (
              <p class="hint" style={{ marginBottom: 0 }}>
                锁定时未选取两点，本副本未带差值。
              </p>
            )}
            <p class="hint" style={{ marginTop: "0.8rem", marginBottom: 0 }}>
              副本内容已冻结，之后新办结的读数只更新在线点表，不改变本副本。
              {!isWriter && "（值班侧只读）"}
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
