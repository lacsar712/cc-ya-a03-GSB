import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";

type LogRow = {
  id: number;
  turbine_code: string;
  yaw_err_deg: number;
  nacelle_temp_c: number | null;
  compensated_yaw_deg: number | null;
  status: string;
  verdict: string | null;
  reason: string | null;
  created_by: string;
  created_at: string;
  processed_at: string | null;
};

type CoefficientRow = {
  turbine_code: string;
  coef_deg_per_c: number;
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
  coef_deg_per_c: number;
  base_temp_c: number;
  compensated_yaw_deg: number;
  recorded_by: string;
  recorded_at: string;
};

type Session = {
  token: string;
  username: string;
  role: string;
};

type View = "logs" | "compensation";

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
      margin-bottom: 1.5rem;
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 0.6rem 1rem;
      margin-bottom: 1rem;
    }
    .brand {
      font-size: 1.15rem;
      font-weight: 700;
      color: #38bdf8;
      margin-right: 0.5rem;
    }
    .topbar nav {
      display: flex;
      gap: 0.4rem;
      flex: 1;
    }
    .topbar .user {
      color: #94a3b8;
      font-size: 0.85rem;
    }
    button.nav {
      background: transparent;
      color: #cbd5e1;
      border: 1px solid #475569;
      font-weight: 600;
    }
    button.nav.active {
      background: #0284c7;
      border-color: #0284c7;
      color: #fff;
    }
    section {
      background: #1e293b;
      border-radius: 8px;
      padding: 1rem 1.25rem;
      margin-bottom: 1rem;
      border: 1px solid #334155;
    }
    h2 {
      margin: 0 0 0.75rem;
      font-size: 1.1rem;
    }
    .note {
      color: #94a3b8;
      font-size: 0.85rem;
      margin: 0.25rem 0 0.75rem;
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
    button {
      cursor: pointer;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      border: none;
      background: #0284c7;
      color: #fff;
      font-weight: 600;
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
      font-size: 0.9rem;
    }
    th,
    td {
      text-align: left;
      padding: 0.5rem 0.4rem;
      border-bottom: 1px solid #334155;
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
      margin-top: 0.5rem;
    }
    .notice {
      color: #86efac;
      margin-top: 0.5rem;
    }
    .row-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 0 1rem;
    }
  `;

  @state() private session: Session | null = null;
  @state() private view: View = "logs";
  @state() private logs: LogRow[] = [];
  @state() private coefficients: CoefficientRow[] = [];
  @state() private ledger: LedgerRow[] = [];
  @state() private loginUser = "technician";
  @state() private loginPass = "tech123456";
  @state() private turbineCode = "";
  @state() private yawErr = "";
  @state() private nacelleTemp = "";
  @state() private coefTurbine = "";
  @state() private coefValue = "";
  @state() private coefBaseTemp = "";
  @state() private error = "";
  @state() private notice = "";
  @state() private loading = false;

  connectedCallback() {
    super.connectedCallback();
    const raw = localStorage.getItem("yaw_session");
    if (raw) {
      try {
        this.session = JSON.parse(raw) as Session;
        void this.refreshAll();
        this._pollTimer = window.setInterval(() => void this.refreshAll(), 2000);
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

  private async refreshAll() {
    if (!this.session) return;
    try {
      const res = await fetch("/api/logs", { headers: this.authHeaders() });
      if (res.status === 401) {
        this.logout();
        return;
      }
      if (res.ok) this.logs = (await res.json()) as LogRow[];
    } catch {
      /* ignore transient network errors */
    }
    try {
      const res = await fetch("/api/coefficients", {
        headers: this.authHeaders(),
      });
      if (res.ok) this.coefficients = (await res.json()) as CoefficientRow[];
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch("/api/compensation-ledger", {
        headers: this.authHeaders(),
      });
      if (res.ok) this.ledger = (await res.json()) as LedgerRow[];
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
      await this.refreshAll();
      this._pollTimer = window.setInterval(() => void this.refreshAll(), 2000);
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
    this.coefficients = [];
    this.ledger = [];
    localStorage.removeItem("yaw_session");
  }

  private get isWriter() {
    return this.session?.role === "writer";
  }

  private setView(view: View) {
    this.view = view;
    this.error = "";
    this.notice = "";
    void this.refreshAll();
  }

  private async submitLog() {
    this.error = "";
    this.notice = "";
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
          nacelle_temp_c:
            this.nacelleTemp === "" ? null : Number(this.nacelleTemp),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.error = data.detail || "提交失败";
        return;
      }
      this.notice =
        `已报送并入队：机组 ${data.turbine_code} 原始 ${data.yaw_err_deg}°，` +
        `补偿后 ${data.compensated_yaw_deg}°（已同笔记入补偿账），等待后台下结论。`;
      this.turbineCode = "";
      this.yawErr = "";
      this.nacelleTemp = "";
      await this.refreshAll();
    } catch {
      this.error = "提交时网络异常";
    } finally {
      this.loading = false;
    }
  }

  private async saveCoefficient() {
    this.error = "";
    this.notice = "";
    this.loading = true;
    try {
      const code = this.coefTurbine.trim();
      const res = await fetch(
        `/api/coefficients/${encodeURIComponent(code)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...this.authHeaders(),
          },
          body: JSON.stringify({
            coef_deg_per_c: Number(this.coefValue),
            base_temp_c: Number(this.coefBaseTemp),
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        this.error = data.detail || "保存系数失败";
        return;
      }
      this.notice =
        `机组 ${data.turbine_code} 系数已保存：` +
        `${data.coef_deg_per_c} 度/℃，基准 ${data.base_temp_c}℃。`;
      this.coefTurbine = "";
      this.coefValue = "";
      this.coefBaseTemp = "";
      await this.refreshAll();
    } catch {
      this.error = "保存系数时网络异常";
    } finally {
      this.loading = false;
    }
  }

  private async editLog(row: LogRow) {
    this.error = "";
    this.notice = "";
    const input = window.prompt(
      `修改记录 #${row.id} 的展示误差（当前 ${row.yaw_err_deg}°，补偿账旧值不受影响）`,
      String(row.yaw_err_deg)
    );
    if (input === null) return;
    const value = Number(input);
    if (Number.isNaN(value)) {
      this.error = "偏航误差必须是数字";
      return;
    }
    try {
      const res = await fetch(`/api/logs/${row.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({ yaw_err_deg: value }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.error = data.detail || "修改失败";
        return;
      }
      this.notice =
        `记录 #${row.id} 展示误差已改为 ${value}°；` +
        `补偿账仍保留当时写下的旧值，可到流水区单独回看。`;
      await this.refreshAll();
    } catch {
      this.error = "修改时网络异常";
    }
  }

  private verdictClass(row: LogRow) {
    if (row.status === "pending") return "pending";
    if (row.verdict === "合格") return "ok";
    if (row.verdict === "偏航超差") return "bad";
    return "";
  }

  private fmtTime(value: string | null) {
    if (!value) return "—";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
  }

  private renderLogin() {
    return html`
      <h1>风机偏航对中台</h1>
      <p class="sub">
        报送偏航读数时后台先扣齿轮箱温漂再下结论，原始与补偿后读数同笔记入补偿账。
      </p>
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

  private renderTopbar() {
    return html`
      <div class="topbar">
        <span class="brand">风机偏航对中台</span>
        <nav>
          <button
            class="nav ${this.view === "logs" ? "active" : ""}"
            @click=${() => this.setView("logs")}
          >
            对中记录
          </button>
          <button
            class="nav ${this.view === "compensation" ? "active" : ""}"
            @click=${() => this.setView("compensation")}
          >
            齿轮箱温漂补偿账
          </button>
        </nav>
        <span class="user">
          ${this.session?.username}（${this.isWriter ? "可提交" : "只读"}）
        </span>
        <button class="secondary" @click=${this.logout}>退出</button>
      </div>
    `;
  }

  private renderLogsView() {
    return html`
      <section>
        <div class="row-actions">
          <h2 style="flex:1;margin:0;">对中记录</h2>
          <button class="secondary" ?disabled=${this.loading} @click=${this.refreshAll}>
            刷新列表
          </button>
        </div>
        <p class="note">
          结论按补偿后偏航判定；技师可改单据展示数字，补偿账里当时写下的旧值不回写。
        </p>
        ${this.error ? html`<p class="err">${this.error}</p>` : null}
        ${this.notice ? html`<p class="notice">${this.notice}</p>` : null}
        <table>
          <thead>
            <tr>
              <th>编号</th>
              <th>机组</th>
              <th>展示误差°</th>
              <th>机舱温度℃</th>
              <th>补偿后°</th>
              <th>状态</th>
              <th>结论</th>
              <th>说明</th>
              ${this.isWriter ? html`<th>操作</th>` : null}
            </tr>
          </thead>
          <tbody>
            ${this.logs.map(
              (row) => html`
                <tr>
                  <td>${row.id}</td>
                  <td>${row.turbine_code}</td>
                  <td>${row.yaw_err_deg}</td>
                  <td>${row.nacelle_temp_c ?? "—"}</td>
                  <td>${row.compensated_yaw_deg ?? "—"}</td>
                  <td>
                    <span class="tag ${row.status === "pending" ? "pending" : "ok"}">
                      ${row.status === "pending" ? "待处理" : "已完成"}
                    </span>
                  </td>
                  <td>
                    ${row.verdict
                      ? html`<span class="tag ${this.verdictClass(row)}">${row.verdict}</span>`
                      : "—"}
                  </td>
                  <td>${row.reason ?? "—"}</td>
                  ${this.isWriter
                    ? html`<td>
                        <button class="secondary" @click=${() => this.editLog(row)}>
                          改数
                        </button>
                      </td>`
                    : null}
                </tr>
              `
            )}
          </tbody>
        </table>
      </section>
    `;
  }

  private renderCoefficientSection() {
    return html`
      <section>
        <h2>系数区 · 机组温漂系数</h2>
        <p class="note">
          系数允许 0~1.0 度/℃，基准温度允许 -30~50 ℃；越界一律退回。
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
            ${this.coefficients.length === 0
              ? html`<tr><td colspan="5">尚未设置任何机组系数</td></tr>`
              : this.coefficients.map(
                  (row) => html`
                    <tr>
                      <td>${row.turbine_code}</td>
                      <td>${row.coef_deg_per_c}</td>
                      <td>${row.base_temp_c}</td>
                      <td>${row.updated_by}</td>
                      <td>${this.fmtTime(row.updated_at)}</td>
                    </tr>
                  `
                )}
          </tbody>
        </table>
        ${this.isWriter
          ? html`
              <div class="form-grid" style="margin-top:0.75rem;">
                <div>
                  <label>机组编号</label>
                  <input
                    placeholder="例如 W12"
                    .value=${this.coefTurbine}
                    @input=${(e: Event) =>
                      (this.coefTurbine = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label>温漂系数（度/℃）</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="例如 0.1"
                    .value=${this.coefValue}
                    @input=${(e: Event) =>
                      (this.coefValue = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label>基准温度（℃）</label>
                  <input
                    type="number"
                    step="0.5"
                    placeholder="例如 20"
                    .value=${this.coefBaseTemp}
                    @input=${(e: Event) =>
                      (this.coefBaseTemp = (e.target as HTMLInputElement).value)}
                  />
                </div>
              </div>
              <button ?disabled=${this.loading} @click=${this.saveCoefficient}>
                保存系数
              </button>
            `
          : html`<p class="note">观察员仅可查看系数与补偿账，不能修改系数。</p>`}
      </section>
    `;
  }

  private renderSubmitSection() {
    if (!this.isWriter) return null;
    return html`
      <section>
        <h2>报送栏 · 偏航读数报送</h2>
        <p class="note">
          报送即入队，后台用机舱温度与系数算出补偿后偏航再下结论；
          入队与补偿账落笔捆绑提交，任一侧失败整题作废。
        </p>
        <div class="form-grid">
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
            <label>原始偏航误差（度，可正可负）</label>
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
          提交报送（入队并同笔记入补偿账）
        </button>
      </section>
    `;
  }

  private renderLedgerSection() {
    return html`
      <section>
        <h2>流水区 · 补偿账</h2>
        <p class="note">
          每笔报送落笔一次，事后在线单据改数不回写此账，旧值可在此单独回看。
        </p>
        <table>
          <thead>
            <tr>
              <th>编号</th>
              <th>关联记录</th>
              <th>机组</th>
              <th>原始读数°</th>
              <th>机舱温度℃</th>
              <th>系数</th>
              <th>基准温度℃</th>
              <th>补偿后°</th>
              <th>记录人</th>
              <th>记录时间</th>
            </tr>
          </thead>
          <tbody>
            ${this.ledger.length === 0
              ? html`<tr><td colspan="10">补偿账暂无流水</td></tr>`
              : this.ledger.map(
                  (row) => html`
                    <tr>
                      <td>${row.id}</td>
                      <td>#${row.log_id}</td>
                      <td>${row.turbine_code}</td>
                      <td>${row.raw_yaw_deg}</td>
                      <td>${row.nacelle_temp_c}</td>
                      <td>${row.coef_deg_per_c}</td>
                      <td>${row.base_temp_c}</td>
                      <td>${row.compensated_yaw_deg}</td>
                      <td>${row.recorded_by}</td>
                      <td>${this.fmtTime(row.recorded_at)}</td>
                    </tr>
                  `
                )}
          </tbody>
        </table>
      </section>
    `;
  }

  private renderCompensationView() {
    return html`
      ${this.renderCoefficientSection()}
      ${this.renderSubmitSection()}
      ${this.renderLedgerSection()}
      ${this.error ? html`<p class="err">${this.error}</p>` : null}
      ${this.notice ? html`<p class="notice">${this.notice}</p>` : null}
    `;
  }

  render() {
    if (!this.session) {
      return this.renderLogin();
    }
    return html`
      ${this.renderTopbar()}
      ${this.view === "logs"
        ? this.renderLogsView()
        : this.renderCompensationView()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "yaw-align-app": YawAlignApp;
  }
}
