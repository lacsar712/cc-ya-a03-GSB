import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";

type LogRow = {
  id: number;
  turbine_code: string;
  yaw_err_deg: number;
  nacelle_temp_c: number | null;
  correction_deg: number | null;
  compensated_yaw_deg: number | null;
  display_yaw_deg: number | null;
  display_updated_by: string | null;
  display_updated_at: string | null;
  status: string;
  verdict: string | null;
  reason: string | null;
  created_by: string;
  created_at: string;
  processed_at: string | null;
};

type CoeffRow = {
  turbine_code: string;
  drift_coef: number;
  base_temp_c: number;
  updated_by: string;
  updated_at: string;
};

type LedgerRow = {
  id: number;
  log_id: number;
  turbine_code: string;
  raw_yaw_deg: number;
  nacelle_temp_c: number;
  drift_coef: number;
  base_temp_c: number;
  temp_delta_c: number;
  correction_deg: number;
  compensated_yaw_deg: number;
  verdict: string | null;
  reason: string | null;
  submitted_by: string;
  created_at: string;
  processed_at: string | null;
};

type Session = {
  token: string;
  username: string;
  role: string;
};

type Tab = "logs" | "ledger";

@customElement("yaw-align-app")
export class YawAlignApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      box-sizing: border-box;
      padding: 1.5rem;
      max-width: 1080px;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 0.25rem;
      font-size: 1.75rem;
      color: #38bdf8;
    }
    .sub {
      color: #94a3b8;
      margin-bottom: 1.25rem;
    }
    .topbar {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 0.6rem 0.9rem;
      margin-bottom: 1rem;
    }
    .topbar .tabs {
      display: flex;
      gap: 0.5rem;
    }
    .topbar .spacer {
      flex: 1;
    }
    .tab {
      background: #334155;
    }
    .tab.active {
      background: #0284c7;
    }
    section {
      background: #1e293b;
      border-radius: 8px;
      padding: 1rem 1.25rem;
      margin-bottom: 1rem;
      border: 1px solid #334155;
    }
    h2 {
      margin-top: 0;
      font-size: 1.1rem;
    }
    label {
      display: block;
      font-size: 0.85rem;
      color: #cbd5e1;
      margin-bottom: 0.25rem;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 0.5rem 0.65rem;
      border-radius: 6px;
      border: 1px solid #475569;
      background: #0f172a;
      color: #f1f5f9;
      margin-bottom: 0.75rem;
    }
    .grid3 {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.75rem;
    }
    button {
      cursor: pointer;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      border: none;
      background: #0284c7;
      color: #fff;
      font-weight: 600;
    }
    button.small {
      padding: 0.3rem 0.7rem;
      font-size: 0.82rem;
    }
    button.secondary {
      background: #475569;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.86rem;
    }
    th,
    td {
      text-align: left;
      padding: 0.45rem 0.4rem;
      border-bottom: 1px solid #334155;
      white-space: nowrap;
    }
    th {
      color: #94a3b8;
      font-weight: 600;
    }
    .tag {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-size: 0.8rem;
    }
    .ok {
      background: #14532d;
      color: #86efac;
    }
    .bad {
      background: #7f1d1d;
      color: #fca5a5;
    }
    .pending {
      background: #713f12;
      color: #fde68a;
    }
    .err {
      color: #f87171;
      margin: 0.5rem 0 0;
    }
    .hint {
      color: #94a3b8;
      font-size: 0.82rem;
      margin: 0 0 0.75rem;
    }
    .muted {
      color: #94a3b8;
    }
    .raw {
      color: #cbd5e1;
    }
    .comp {
      color: #7dd3fc;
      font-weight: 600;
    }
    .edit-wrap {
      display: flex;
      gap: 0.4rem;
      align-items: center;
    }
    .edit-wrap input {
      width: 6rem;
      margin: 0;
    }
  `;

  @state() private session: Session | null = null;
  @state() private tab: Tab = "logs";
  @state() private logs: LogRow[] = [];
  @state() private coeffs: CoeffRow[] = [];
  @state() private ledger: LedgerRow[] = [];
  @state() private loginUser = "technician";
  @state() private loginPass = "tech123456";

  // 报送栏
  @state() private turbineCode = "";
  @state() private yawErr = "";
  @state() private nacelleTemp = "";
  @state() private submitError = "";
  @state() private submitOk = "";

  // 系数区
  @state() private coeffTurbine = "";
  @state() private driftCoef = "";
  @state() private baseTemp = "";
  @state() private coeffError = "";
  @state() private coeffOk = "";

  // 在线单据展示数字修改
  @state() private editingLogId: number | null = null;
  @state() private editDisplay = "";

  @state() private error = "";
  @state() private loading = false;

  connectedCallback() {
    super.connectedCallback();
    const raw = localStorage.getItem("yaw_session");
    if (raw) {
      try {
        this.session = JSON.parse(raw) as Session;
        void this.refreshActive();
        this._pollTimer = window.setInterval(() => void this.refreshActive(), 2000);
      } catch {
        localStorage.removeItem("yaw_session");
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
    }
  }

  private _pollTimer?: number;

  private authHeaders(): HeadersInit {
    return this.session
      ? { Authorization: `Bearer ${this.session.token}` }
      : {};
  }

  private get isWriter() {
    return this.session?.role === "writer";
  }

  private switchTab(tab: Tab) {
    this.tab = tab;
    void this.refreshActive();
  }

  private async refreshActive() {
    if (!this.session) return;
    await this.refreshLogs();
    if (this.tab === "ledger") {
      await Promise.all([this.refreshCoeffs(), this.refreshLedger()]);
    }
  }

  private async refreshLogs() {
    try {
      const res = await fetch("/api/logs", { headers: this.authHeaders() });
      if (res.status === 401) {
        this.logout();
        return;
      }
      if (!res.ok) return;
      this.logs = (await res.json()) as LogRow[];
    } catch {
      /* ignore transient network errors */
    }
  }

  private async refreshCoeffs() {
    try {
      const res = await fetch("/api/coeffs", { headers: this.authHeaders() });
      if (res.status === 401) {
        this.logout();
        return;
      }
      if (!res.ok) return;
      this.coeffs = (await res.json()) as CoeffRow[];
    } catch {
      /* ignore */
    }
  }

  private async refreshLedger() {
    try {
      const res = await fetch("/api/ledger", { headers: this.authHeaders() });
      if (res.status === 401) {
        this.logout();
        return;
      }
      if (!res.ok) return;
      this.ledger = (await res.json()) as LedgerRow[];
    } catch {
      /* ignore */
    }
  }

  private async login() {
    this.error = "";
    this.loading = true;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: this.loginUser,
          password: this.loginPass,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.error = data.detail || "登录失败";
        return;
      }
      this.session = {
        token: data.access_token,
        username: data.username,
        role: data.role,
      };
      localStorage.setItem("yaw_session", JSON.stringify(this.session));
      await this.refreshActive();
      this._pollTimer = window.setInterval(() => void this.refreshActive(), 2000);
    } catch {
      this.error = "无法连接接口";
    } finally {
      this.loading = false;
    }
  }

  private logout() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this.session = null;
    this.logs = [];
    this.coeffs = [];
    this.ledger = [];
    localStorage.removeItem("yaw_session");
  }

  // ---- 报送栏：温度 + 原始读数一并提交，后端入队与落账捆绑 ----
  private async submitLog() {
    this.submitError = "";
    this.submitOk = "";
    this.loading = true;
    try {
      const res = await fetch("/api/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          turbine_code: this.turbineCode,
          yaw_err_deg: Number(this.yawErr),
          nacelle_temp_c: Number(this.nacelleTemp),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.submitError = data.detail || "提交失败";
        return;
      }
      this.submitOk =
        `已入队：原始 ${data.yaw_err_deg}°，机舱 ${data.nacelle_temp_c}℃，` +
        `补偿后 ${data.compensated_yaw_deg}°，补偿账已同步落笔`;
      this.turbineCode = "";
      this.yawErr = "";
      this.nacelleTemp = "";
      await this.refreshActive();
    } catch {
      this.submitError = "提交时网络异常";
    } finally {
      this.loading = false;
    }
  }

  // ---- 系数区：writer 可设，越界由后端退回 ----
  private async saveCoeff() {
    this.coeffError = "";
    this.coeffOk = "";
    try {
      const res = await fetch(`/api/coeffs/${encodeURIComponent(this.coeffTurbine)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          drift_coef: Number(this.driftCoef),
          base_temp_c: Number(this.baseTemp),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.coeffError = data.detail || "保存失败";
        return;
      }
      this.coeffOk = `机组 ${data.turbine_code} 系数已保存`;
      this.coeffTurbine = "";
      this.driftCoef = "";
      this.baseTemp = "";
      await this.refreshCoeffs();
    } catch {
      this.coeffError = "保存时网络异常";
    }
  }

  // ---- 在线单据展示数字：只改展示，不动补偿账 ----
  private startEdit(row: LogRow) {
    this.editingLogId = row.id;
    this.editDisplay = String(row.display_yaw_deg ?? row.yaw_err_deg);
  }

  private cancelEdit() {
    this.editingLogId = null;
    this.editDisplay = "";
  }

  private async saveDisplay(row: LogRow) {
    try {
      const res = await fetch(`/api/logs/${row.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({ display_yaw_deg: Number(this.editDisplay) }),
      });
      const data = await res.json();
      if (!res.ok) {
        window.alert(data.detail || "修改失败");
        return;
      }
      this.cancelEdit();
      await this.refreshLogs();
    } catch {
      window.alert("修改时网络异常");
    }
  }

  private verdictClass(verdict: string | null, pending: boolean) {
    if (pending) return "pending";
    if (verdict === "合格") return "ok";
    if (verdict === "偏航超差") return "bad";
    return "";
  }

  private fmt(n: number | null, digits = 2) {
    return n === null || n === undefined ? "—" : Number(n).toFixed(digits);
  }

  render() {
    if (!this.session) {
      return html`
        <h1>风机偏航对中台</h1>
        <p class="sub">现场技师报送偏航误差与机舱温度，后台扣齿轮箱温漂后给出结论。</p>
        <section>
          <label>用户名</label>
          <input
            .value=${this.loginUser}
            @input=${(e: Event) =>
              (this.loginUser = (e.target as HTMLInputElement).value)}
          />
          <label>密码</label>
          <input
            type="password"
            .value=${this.loginPass}
            @input=${(e: Event) =>
              (this.loginPass = (e.target as HTMLInputElement).value)}
          />
          <button ?disabled=${this.loading} @click=${this.login}>登录</button>
          ${this.error ? html`<p class="err">${this.error}</p>` : null}
        </section>
      `;
    }

    return html`
      <h1>风机偏航对中台</h1>
      <div class="topbar">
        <div class="tabs">
          <button
            class="tab ${this.tab === "logs" ? "active" : "secondary"}"
            @click=${() => this.switchTab("logs")}
          >
            对中记录
          </button>
          <button
            class="tab ${this.tab === "ledger" ? "active" : "secondary"}"
            @click=${() => this.switchTab("ledger")}
          >
            齿轮箱温漂补偿账
          </button>
        </div>
        <span class="spacer"></span>
        <span class="muted">
          ${this.session.username}（${this.isWriter ? "技师·可提交" : "观察员·只读"}）
        </span>
        <button class="secondary small" ?disabled=${this.loading} @click=${this.refreshActive}>
          刷新
        </button>
        <button class="secondary small" @click=${this.logout}>退出</button>
      </div>

      ${this.tab === "logs" ? this.renderLogs() : this.renderLedgerPage()}
    `;
  }

  private renderLogs() {
    return html`
      <section>
        <h2>对中记录（在线单据）</h2>
        <p class="hint">
          结论按补偿后偏航（±1.5°）判定。「展示读数」可事后修改，仅影响本单据显示；
          补偿账流水里落笔时的原始/补偿后旧值不会改变，可在补偿账专页单独回看。
        </p>
        <table>
          <thead>
            <tr>
              <th>编号</th>
              <th>机组</th>
              <th>原始读数°</th>
              <th>机舱℃</th>
              <th>补偿量°</th>
              <th>补偿后°</th>
              <th>展示读数°</th>
              <th>状态</th>
              <th>结论</th>
            </tr>
          </thead>
          <tbody>
            ${this.logs.map(
              (row) => html`
                <tr>
                  <td>${row.id}</td>
                  <td>${row.turbine_code}</td>
                  <td class="raw">${this.fmt(row.yaw_err_deg)}</td>
                  <td>${this.fmt(row.nacelle_temp_c, 1)}</td>
                  <td>${this.fmt(row.correction_deg)}</td>
                  <td class="comp">${this.fmt(row.compensated_yaw_deg)}</td>
                  <td>
                    ${this.editingLogId === row.id
                      ? html`
                          <div class="edit-wrap">
                            <input
                              type="number"
                              step="0.1"
                              .value=${this.editDisplay}
                              @input=${(e: Event) =>
                                (this.editDisplay = (e.target as HTMLInputElement).value)}
                            />
                            <button class="small" @click=${() => this.saveDisplay(row)}>
                              存
                            </button>
                            <button class="small secondary" @click=${this.cancelEdit}>
                              罢
                            </button>
                          </div>
                        `
                      : html`
                          <div class="edit-wrap">
                            <span>${this.fmt(row.display_yaw_deg)}</span>
                            ${this.isWriter
                              ? html`
                                  <button
                                    class="small secondary"
                                    @click=${() => this.startEdit(row)}
                                  >
                                    改展示
                                  </button>
                                `
                              : null}
                          </div>
                        `}
                  </td>
                  <td>
                    <span class="tag ${this.verdictClass(null, row.status === "pending")}">
                      ${row.status === "pending" ? "待处理" : "已完成"}
                    </span>
                  </td>
                  <td>
                    ${row.verdict
                      ? html`
                          <span class="tag ${this.verdictClass(row.verdict, false)}">
                            ${row.verdict}
                          </span>
                        `
                      : "—"}
                  </td>
                </tr>
              `
            )}
          </tbody>
        </table>
      </section>
    `;
  }

  private renderLedgerPage() {
    return html`
      <!-- 报送栏 -->
      <section>
        <h2>报送栏</h2>
        <p class="hint">
          报送须带机舱温度；提交后进入待认领队列并同步写入补偿账，两侧捆绑、不可拆分。
          系数须先在下方系数区设置。
        </p>
        ${this.isWriter
          ? html`
              <div class="grid3">
                <div>
                  <label>机组编号</label>
                  <input
                    placeholder="例如 W12"
                    .value=${this.turbineCode}
                    @input=${(e: Event) =>
                      (this.turbineCode = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label>偏航原始读数（度，可正可负）</label>
                  <input
                    type="number"
                    step="0.1"
                    .value=${this.yawErr}
                    @input=${(e: Event) =>
                      (this.yawErr = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label>机舱温度（℃）</label>
                  <input
                    type="number"
                    step="0.1"
                    .value=${this.nacelleTemp}
                    @input=${(e: Event) =>
                      (this.nacelleTemp = (e.target as HTMLInputElement).value)}
                  />
                </div>
              </div>
              <button ?disabled=${this.loading} @click=${this.submitLog}>
                报送（入队并落补偿账）
              </button>
              ${this.submitError ? html`<p class="err">${this.submitError}</p>` : null}
              ${this.submitOk
                ? html`<p class="hint" style="color:#86efac">${this.submitOk}</p>`
                : null}
            `
          : html`<p class="hint">观察员账号为只读，不能报送或设置系数。</p>`}
      </section>

      <!-- 系数区 -->
      <section>
        <h2>系数区 · 齿轮箱温漂系数</h2>
        <p class="hint">
          补偿后读数 = 原始读数 + 系数 × (机舱温度 − 基准温度)。
          系数允许范围 −1.0 至 1.0（度/℃），基准温度 −50℃ 至 100℃，越界提交会被退回。
        </p>
        <table>
          <thead>
            <tr>
              <th>机组</th>
              <th>温漂系数（度/℃）</th>
              <th>基准温度℃</th>
              <th>设置人</th>
              <th>设置时间</th>
            </tr>
          </thead>
          <tbody>
            ${this.coeffs.map(
              (c) => html`
                <tr>
                  <td>${c.turbine_code}</td>
                  <td>${this.fmt(c.drift_coef, 3)}</td>
                  <td>${this.fmt(c.base_temp_c, 1)}</td>
                  <td>${c.updated_by}</td>
                  <td>${new Date(c.updated_at).toLocaleString()}</td>
                </tr>
              `
            )}
            ${this.coeffs.length === 0
              ? html`<tr><td colspan="5" class="muted">尚未设置任何机组系数</td></tr>`
              : null}
          </tbody>
        </table>
        ${this.isWriter
          ? html`
              <div class="grid3" style="margin-top:0.9rem;">
                <div>
                  <label>机组编号</label>
                  <input
                    placeholder="例如 W12"
                    .value=${this.coeffTurbine}
                    @input=${(e: Event) =>
                      (this.coeffTurbine = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label>温漂系数（度/℃）</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="例如 0.1"
                    .value=${this.driftCoef}
                    @input=${(e: Event) =>
                      (this.driftCoef = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label>基准温度（℃）</label>
                  <input
                    type="number"
                    step="0.1"
                    placeholder="例如 20"
                    .value=${this.baseTemp}
                    @input=${(e: Event) =>
                      (this.baseTemp = (e.target as HTMLInputElement).value)}
                  />
                </div>
              </div>
              <button @click=${this.saveCoeff}>设置 / 更新系数</button>
              ${this.coeffError ? html`<p class="err">${this.coeffError}</p>` : null}
              ${this.coeffOk
                ? html`<p class="hint" style="color:#86efac">${this.coeffOk}</p>`
                : null}
            `
          : html`<p class="hint">观察员可查看系数，但不能修改。</p>`}
      </section>

      <!-- 流水区：补偿账快照，事后不可改 -->
      <section>
        <h2>流水区 · 补偿账（落笔快照）</h2>
        <p class="hint">
          每笔记录落笔时的原始读数、机舱温度、所用系数/基准温度、补偿量与补偿后读数都保存在此；
          在线单据展示数字事后被改动，不影响本账旧值，可逐笔单独回看。
        </p>
        <table>
          <thead>
            <tr>
              <th>账编号</th>
              <th>单编号</th>
              <th>机组</th>
              <th>原始读数°</th>
              <th>机舱℃</th>
              <th>系数</th>
              <th>基准℃</th>
              <th>温差℃</th>
              <th>补偿量°</th>
              <th>补偿后°</th>
              <th>结论</th>
              <th>报送人</th>
            </tr>
          </thead>
          <tbody>
            ${this.ledger.map(
              (r) => html`
                <tr>
                  <td>${r.id}</td>
                  <td>${r.log_id}</td>
                  <td>${r.turbine_code}</td>
                  <td class="raw">${this.fmt(r.raw_yaw_deg)}</td>
                  <td>${this.fmt(r.nacelle_temp_c, 1)}</td>
                  <td>${this.fmt(r.drift_coef, 3)}</td>
                  <td>${this.fmt(r.base_temp_c, 1)}</td>
                  <td>${this.fmt(r.temp_delta_c, 1)}</td>
                  <td>${this.fmt(r.correction_deg)}</td>
                  <td class="comp">${this.fmt(r.compensated_yaw_deg)}</td>
                  <td>
                    ${r.verdict
                      ? html`
                          <span class="tag ${this.verdictClass(r.verdict, false)}">
                            ${r.verdict}
                          </span>
                        `
                      : html`<span class="tag pending">待下结论</span>`}
                  </td>
                  <td>${r.submitted_by}</td>
                </tr>
              `
            )}
            ${this.ledger.length === 0
              ? html`<tr><td colspan="12" class="muted">补偿账暂无流水</td></tr>`
              : null}
          </tbody>
        </table>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "yaw-align-app": YawAlignApp;
  }
}
