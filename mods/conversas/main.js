// Últimas conversas do Claude Code de cada pasta, abaixo de Agents.
// Clique retoma a conversa numa aba nova da pasta; botão direito copia o comando.
// A coleta é o conversas.py desta pasta, que o plugin do herdr de terminal
// (tui/ no repositório herdr-mods) também usa.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, InputState, Input } from "gpui-base";
import { exec, spaces, panes, run, theme, notify, checking, appHome, window, props, openOverlay, closeOverlay, machines, shared, setShared, readTextFile, focused } from "herdr";

// Mesmo main.js no Windows e no Linux: só o Python muda.
// window() é null antes da janela existir (na abertura do app): a pasta do app com letra de unidade também indica Windows.
const WINDOWS = () => window()?.platform === "windows" || /^[A-Za-z]:[\\/]/.test(appHome());
const SCRIPT = () => `${appHome()}/mods/conversas/conversas.py`;
const PYTHON = () => (WINDOWS() ? "python" : "python3");

// Roda o conversas.py neste computador (maquina null) ou noutra máquina do herdr. Na outra,
// o script vai como texto em `python3 -c`, pelo herdr-core dela: não depende de onde (nem se)
// o herdr-mods está instalado lá, só do Python e das conversas em ~/.claude/projects.
let codigo = null;
async function rodar(args, maquina, timeout) {
  if (!maquina) return exec(PYTHON(), [SCRIPT(), ...args], { timeout });
  codigo ??= await readTextFile(SCRIPT());
  if (!codigo) throw new Error(`Não achei ${SCRIPT()}`);
  try {
    return await exec("python3", ["-c", codigo, ...args], { on: maquina, timeout });
  } catch {
    return exec("python", ["-c", codigo, ...args], { on: maquina, timeout }); // máquina Windows
  }
}

// Nome exibido de cada máquina, o mesmo do spaces-icones: o dado à mão (shared "machine.names",
// "" para este computador), senão a remota com inicial maiúscula e esta pelo sistema.
const PLATAFORMA = { windows: "Windows", macos: "Mac", linux: "Linux" };
const nomeMaquina = (m) => (shared("machine.names") ?? {})[m ?? ""] || (m ? m[0].toUpperCase() + m.slice(1) : PLATAFORMA[window()?.platform] ?? "Este computador");
const COMANDO = (id) => `claude --dangerously-skip-permissions --resume ${id}`;
const POR_PAGINA = 2;   // conversas por página em cada pasta
const LIMITE = 50;      // conversas por pasta pedidas ao coletor (as mais recentes)

// Última lista lida de cada máquina, para o painel mostrar na hora e reler por trás.
const CACHE = (m) => `grupos:${m ?? ""}`;
function lerCache(m) {
  try { return JSON.parse(localStorage.getItem(CACHE(m)) ?? "[]") ?? []; } catch { return []; }
}

const norm = (p) => (p ?? "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
const nome = (p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
// Bytes em KB, MB ou GB, com vírgula: "531 MB", "7,2 MB", "1,4 GB".
function tamanho(b) {
  const [n, u] = b >= 1e9 ? [b / 1e9, "GB"] : b >= 1e6 ? [b / 1e6, "MB"] : [b / 1e3, "KB"];
  return `${(n >= 100 ? Math.round(n) : Math.round(n * 10) / 10).toString().replace(".", ",")} ${u}`;
}
// Pesquisa sem caixa nem acento: "acao" acha "Ação".
const plano = (s) => (s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function quando(seg) {
  const d = new Date(seg * 1000);
  const hoje = new Date();
  const hh = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === hoje.toDateString()) return hh;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Aba nova no space que já está nessa pasta, na máquina da conversa; senão, um space novo nela lá.
function retomar(c, maquina) {
  const argv = ["claude", "--dangerously-skip-permissions", "--resume", c.id];
  const alvo = norm(c.cwd);
  const todos = spaces().filter((s) => (s.machine ?? null) === (maquina ?? null));
  const aba = panes().find((p) => norm(p.cwd) === alvo && todos.some((s) => s.tabs.some((t) => t.id === p.tab)))?.tab;
  const porPainel = aba && todos.find((s) => s.tabs.some((t) => t.id === aba))?.id;
  const space = porPainel ?? todos.find((s) => norm(s.folder) === alvo)?.id;
  if (space) run("tab.new", { space, folder: c.cwd, argv, name: c.titulo.slice(0, 24) });
  else run("space.new", { folder: c.cwd, argv, ...(maquina ? { machine: maquina } : {}) });
}

// Hora de um timestamp ISO das falas, no mesmo formato da lista.
const quandoIso = (iso) => { const ms = Date.parse(iso); return Number.isNaN(ms) ? "" : quando(ms / 1000); };

export default class Conversas extends View {
  init(_props, cx) {
    // Aberto pelo ícone de uma conversa: o modal com as últimas falas dela.
    if (props()?.conversa) {
      this.falas = null;
      this.erro = null;
      this.rolagem = ScrollHandle.new();
      // Ordem das falas: vale para todos os modais até ser trocada de novo. Fica no shared
      // porque cada modal aberto ganha um localStorage próprio (data/conversas/store-<hash>.json).
      this.invertido = shared("conversas.falasInvertidas") === true;
      if (!checking()) this.lerFalas(cx);
      return;
    }
    this.erro = null;
    // Um campo só, para a conversa cujo nome está sendo editado pelo lápis (this.editando = id).
    this.editando = null;
    this.nome = InputState.new({ placeholder: "Nome da conversa" });
    this.nome.on("submit", (_e, cx) => this.renomear(cx));
    this.nome.on("blur", (_e, cx) => { if (this.editando) { this.editando = null; cx.notify(); } });
    // Pesquisa: filtra a lista carregada por título, pasta e ID a cada tecla.
    this.filtro = "";
    this.busca = InputState.new({ placeholder: "Pesquisar por título, pasta ou ID" });
    this.busca.on("change", (_e, cx) => { this.filtro = this.busca.value(); cx.notify(); });
    // Pastas fechadas por padrão: só abre a da janela com o foco (ou a que a pessoa abrir).
    this.abertos = new Set();
    // Página de cada pasta: fica guardada entre aberturas.
    let estado = {};
    try { estado = JSON.parse(localStorage.getItem("estado") ?? "{}") ?? {}; } catch { estado = {}; }
    this.paginas = estado.paginas && typeof estado.paginas === "object" ? estado.paginas : {};
    // De qual máquina são as conversas mostradas (null: este computador); fica guardada também.
    this.maquina = typeof estado.maquina === "string" ? estado.maquina : null;
    this.grupos = lerCache(this.maquina);
    this.vez = 0; // cada leitura leva um número: a resposta de uma máquina antiga é descartada
    this.lista = ScrollHandle.new();
    this.foco = null; // { cwd, maquina } da janela com o foco
    if (checking()) return;
    // Sem timer: a lista só se relê sozinha quando a pasta da janela com o foco não está nela.
    if (!this.grupos.length) this.carregar(cx);
  }

  salvar() {
    localStorage.setItem("estado", JSON.stringify({ paginas: this.paginas, maquina: this.maquina }));
  }

  trocarMaquina(m, cx) {
    if ((m ?? null) === this.maquina) return;
    this.maquina = m ?? null;
    this.grupos = lerCache(this.maquina);
    this.erro = null;
    this.editando = null;
    this.salvar();
    // Com a lista dessa máquina já lida, só troca, sem reler.
    if (this.grupos.length) { this.vez++; this.carregando = false; cx.notify(); }
    else this.carregar(cx);
  }

  // O foco foi para outra janela: a lista vai para a máquina dela e começa pela pasta dela.
  focar(maquina, cx) {
    this.trocarMaquina(maquina, cx);
    this.lista.scroll_to_item(0);
    cx.notify();
  }

  // Todas abertas ou todas fechadas (chaves = pastas).
  todas(abrir) {
    this.abertos = new Set(abrir ? this.grupos.map((g) => g.cwd) : []);
  }

  carregar(cx) {
    this.releu = this.chaveFoco; // esta leitura já vale como a nova tentativa de achar a pasta do foco
    const vez = ++this.vez, maquina = this.maquina;
    this.carregando = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let grupos = null, erro = null;
      try {
        const r = await rodar(["--listar", "--limite", String(LIMITE)], maquina, 60000);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `saiu com ${r.code}`);
        grupos = JSON.parse(r.stdout);
        localStorage.setItem(CACHE(maquina), r.stdout);
      } catch (e) {
        erro = maquina ? `${nomeMaquina(maquina)}: ${e?.message ?? e}` : String(e?.message ?? e);
      }
      if (vez !== this.vez) return; // trocou de máquina ou releu no meio: vale a leitura mais nova
      if (grupos) this.grupos = grupos;
      this.erro = erro;
      this.carregando = false;
      cx.notify();
    });
  }

  editar(c) {
    this.editando = c.id;
    this.nome.set_value(c.titulo);
    this.nome.set_selected_range({ start: 0, end: c.titulo.length });
    this.nome.focus();
  }

  // Grava como o /rename do Claude Code; a lista mostra o nome novo na hora e relê em seguida.
  renomear(cx) {
    const id = this.editando, novo = this.nome.value().trim();
    this.editando = null;
    const c = this.grupos.flatMap((g) => g.conversas).find((x) => x.id === id);
    if (!c || !novo || novo === c.titulo) return cx.notify();
    const antigo = c.titulo;
    c.titulo = novo;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await rodar(["--renomear", id, novo], this.maquina, 30000).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) {
        c.titulo = antigo;
        notify({ title: "Não deu para renomear", body: r.stderr.trim() || "Conversa não encontrada.", level: "error", timeout: 5000 });
        cx.notify();
      } else this.carregar(cx);
    });
  }

  lerFalas(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await rodar(["--ultimas", props().conversa.id], props().conversa.maquina ?? null, 30000);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `saiu com ${r.code}`);
        this.falas = JSON.parse(r.stdout);
        this.rolar();
      } catch (e) {
        this.erro = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // Abre na parte mais recente: no topo com a ordem invertida, no fim com a normal.
  rolar() {
    if (this.falas?.length) this.rolagem.scroll_to_item(this.invertido ? 0 : this.falas.length - 1);
  }

  inverter() {
    this.invertido = !this.invertido;
    setShared("conversas.falasInvertidas", this.invertido);
    this.rolar();
  }

  modal(t) {
    const c = props().conversa;
    const fala = (f, i) => v_flex()
      .id(`fl-${i}`)
      .gap(4)
      .p(10)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(f.papel === "user" ? t.raised : t.background)
      .child(h_flex().gap(6).items_center().text_size(11)
        .child(div().font_semibold().text_color(f.papel === "user" ? t.accent : t.foreground).child(f.papel === "user" ? "Você" : "Claude"))
        .child(div().text_color(t.dim).child(quandoIso(f.quando))))
      .child(div().text_size(12.5).whitespace_normal().text_color(t.foreground).child(f.texto));
    const aviso = (texto, cor) => div().p(14).text_size(12).text_color(cor).child(texto);
    return v_flex()
      .id("cv-modal")
      .size_full()
      .min_h(0)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(h_flex().px(18).pt(14).pb(10).gap(10).items_center().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(14).font_semibold().child(c.titulo))
          .child(div().truncate().text_size(11).text_color(t.dim).child(`${c.maquina ? `${nomeMaquina(c.maquina)} · ` : ""}${c.pasta} · ${c.id}`)))
        .child(div().id("cv-modal-ordem").h(22).px(8).flex().items_center().rounded(5).border_1().border_color(t.border)
          .text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Inverter a ordem das falas")
          .on_click((_e, cx) => { this.inverter(); cx.notify(); })
          .child(this.invertido ? "↑ Mais novas primeiro" : "↓ Mais antigas primeiro"))
        .child(div().text_size(11).text_color(t.dim).child("Esc"))
        .child(this.acao(t, "cv-modal-fechar", "Fechar", "mods/workspace-chrome/x.svg", () => closeOverlay(props().overlay))))
      .when(Boolean(this.erro), (el) => el.child(aviso(this.erro, t.blocked)))
      .when(!this.erro && !this.falas, (el) => el.child(aviso("Lendo a conversa…", t.dim)))
      .when(!this.erro && this.falas?.length === 0, (el) => el.child(aviso("Nenhuma fala de texto nesta conversa.", t.dim)))
      .child(v_flex().id("cv-falas").flex_1().min_h(0).p(14).gap(8).overflow_y_scrollbar().track_scroll(this.rolagem)
        .children((this.invertido ? [...(this.falas ?? [])].reverse() : this.falas ?? []).map(fala)));
  }

  acao(t, id, dica, icone, fazer) {
    return div().id(id).size(22).flex().items_center().justify_center().rounded(5).text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(dica)
      .on_click((_e, cx) => { fazer(); cx.notify(); }).child(svg(icone).size(12));
  }

  render(cx) {
    const t = theme();
    if (props()?.conversa) return this.modal(t);
    // Lido a cada render: um painel escondido não renderiza, então detectar a abertura perdia trocas de foco.
    const f = focused(), s = spaces().find((x) => x.id === f?.space);
    const foco = s && { cwd: norm(f.cwd ?? s.folder), maquina: s.machine ?? null };
    if (foco && `${foco.maquina} ${foco.cwd}` !== this.chaveFoco && !checking()) {
      this.chaveFoco = `${foco.maquina} ${foco.cwd}`;
      this.foco = foco;
      this.abertos = new Set();
      this.abrirFoco = true;
      // Depois do render: cx.spawn roda o corpo já, e o cx.notify() de carregar() lança durante o render.
      cx.timer.after(0, (cx) => this.focar(foco.maquina, cx));
    }
    // Ícone que abre o modal das últimas falas, sem retomar a conversa.
    const ver = (c) => div().id(`cvv-${c.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.background).text_color(t.foreground))
      .tooltip("Ver as últimas falas")
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "conversas", kind: "dialog", width: 720, height: 620, // Só o nome da pasta: as props do overlay perdem as barras invertidas do caminho.
          props: { conversa: { id: c.id, titulo: c.titulo, pasta: nome(c.cwd), maquina: this.maquina } } });
      })
      .child(svg("mods/workspace-chrome/file-text.svg").size(13));
    // Lápis: troca o título por um campo; Enter grava, Esc ou clicar fora desiste.
    const lapis = (c) => div().id(`cve-${c.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.background).text_color(t.foreground))
      .tooltip("Renomear")
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.editar(c); cx.notify(); })
      .child(svg("mods/workspace-chrome/square-pen.svg").size(13));
    const campo = () => div().flex_1().min_w(0)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => { if (e.key === "escape") { this.editando = null; cx.stop_propagation(); cx.notify(); } })
      .child(Input.new(this.nome).h(24).px(6).rounded(5).border_1().border_color(t.accent).bg(t.background).text_size(13));
    const linha = (c) =>
      v_flex()
        .id(`cv-${c.id}`)
        .ml(10)
        .px(8)
        .py(4)
        .flex_none()
        .rounded(8)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        // Editando o nome, a linha não retoma a conversa nem mostra a dica.
        .when(this.editando !== c.id, (el) => el
          .tooltip(`Clique: retomar · botão direito: copiar\n${COMANDO(c.id)}`)
          .on_click(() => retomar(c, this.maquina)))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          cx.write_to_clipboard(COMANDO(c.id));
          notify({ title: "Comando copiado", body: COMANDO(c.id), level: "info", timeout: 3000 });
        })
        .child(h_flex().gap(6).items_center()
          .when(this.editando === c.id, (el) => el.child(campo()))
          .when(this.editando !== c.id, (el) => el
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.titulo))
            .child(lapis(c)))
          .child(ver(c))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(quando(c.quando))))
        .child(div().text_size(10.5).truncate().text_color(t.dim).child(c.id));

    // Com pesquisa, cada pasta mostra todas as conversas que batem, aberta e sem páginas.
    const termos = plano(this.filtro).split(/\s+/).filter(Boolean);
    const filtrando = termos.length > 0;
    const bate = (g, c) => { const alvo = plano(`${c.titulo} ${nome(g.cwd)} ${c.id}`); return termos.every((x) => alvo.includes(x)); };
    const filtrados = filtrando
      ? this.grupos.map((g) => ({ ...g, conversas: g.conversas.filter((c) => bate(g, c)) })).filter((g) => g.conversas.length)
      : this.grupos;
    // A pasta da janela com o foco (a mais funda que contém o cwd dela) vai primeiro, destacada e aberta.
    const naPasta = (g) => this.foco.cwd === norm(g.cwd) || this.foco.cwd.startsWith(norm(g.cwd) + "\\");
    const meu = this.foco?.maquina === this.maquina
      ? filtrados.filter(naPasta).reduce((a, g) => (!a || g.cwd.length > a.cwd.length ? g : a), null)
      : null;
    // Pasta do foco fora da lista (ela mesma, não um ancestral como D:): relê uma vez por troca de foco,
    // o único reload automático.
    if (this.foco?.maquina === this.maquina && !this.carregando && this.releu !== this.chaveFoco && !this.grupos.some((g) => norm(g.cwd) === this.foco.cwd)) {
      this.releu = this.chaveFoco;
      cx.timer.after(0, (cx) => this.carregar(cx));
    }
    if (meu && this.abrirFoco) { this.abrirFoco = false; this.abertos = new Set([meu.cwd]); }
    const visiveis = meu ? [meu, ...filtrados.filter((g) => g !== meu)] : filtrados;

    const grupo = (g) => {
      const aberto = filtrando || this.abertos.has(g.cwd);
      const total = filtrando ? 1 : Math.max(1, Math.ceil(g.conversas.length / POR_PAGINA));
      const pagina = filtrando ? 0 : Math.min(this.paginas[g.cwd] ?? 0, total - 1);
      const ir = (d) => (_e, cx) => {
        cx.stop_propagation();
        this.paginas[g.cwd] = Math.max(0, Math.min(total - 1, pagina + d));
        this.salvar();
        cx.notify();
      };
      const seta = (id, texto, d, pode) => div().id(id).w(18).h(20).flex().items_center().justify_center().rounded(5)
        .text_color(pode ? t.muted : t.border).when(pode, (el) => el.cursor_pointer().hover((s) => s.bg(t.background).text_color(t.foreground)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .when(pode, (el) => el.on_click(ir(d))).child(texto);
      return [
        // Cabeçalho da pasta em faixa própria (fundo, ícone, negrito) para separar os projetos.
        h_flex()
          .id(`cg-${g.cwd}`)
          .mt(8)
          .mb(2)
          .px(8)
          .h(30)
          .flex_none()
          .gap(7)
          .items_center()
          .rounded(7)
          .bg(g === meu ? t.selected : t.raised)
          .border_1()
          .border_color(g === meu ? t.accent : t.border)
          .text_size(12.5)
          .font_semibold()
          .text_color(t.foreground)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(g.cwd)
          .on_click((_e, cx) => {
            aberto ? this.abertos.delete(g.cwd) : this.abertos.add(g.cwd);
            cx.notify();
          })
          .child(svg("mods/workspace-chrome/folder.svg").size(14).flex_none().text_color(t.accent))
          .child(div().flex_1().min_w(0).truncate().child(nome(g.cwd)))
          // Paginação da pasta: ‹ 1/5 ›, só aberta e com mais de uma página.
          .when(aberto && total > 1, (el) => el.child(h_flex().flex_none().gap(1).items_center().text_size(11).font_medium()
            .child(seta(`cp-${g.cwd}`, "‹", -1, pagina > 0))
            .child(div().text_color(t.muted).child(`${pagina + 1}/${total}`))
            .child(seta(`cn-${g.cwd}`, "›", 1, pagina < total - 1))))
          // Tamanho em disco da pasta do projeto em ~/.claude/projects (conversas, subagentes, anexos).
          .when(g.tamanho > 0, (el) => el.child(div().flex_none().text_size(10.5).font_normal().text_color(t.dim).child(tamanho(g.tamanho))))
          .child(div().flex_none().text_size(10.5).font_medium().text_color(t.muted).child(String(g.conversas.length)))
          .child(svg(`mods/workspace-chrome/chevron-${aberto ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim)),
        ...(aberto ? (filtrando ? g.conversas : g.conversas.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA)).map(linha) : []),
      ];
    };

    // Painel lateral direito, no mesmo cartão de Files e Changes.
    const total = visiveis.reduce((n, g) => n + g.conversas.length, 0);
    const maquinas = machines();
    return v_flex()
      .id("conversas")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child("Conversas"))
          .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${total}`))
          .child(div().flex_1())
          .child(this.acao(t, "cv-abrir", "Expandir todas", "mods/workspace-chrome/chevron-down.svg", () => this.todas(true)))
          .child(this.acao(t, "cv-fechar", "Recolher todas", "mods/workspace-chrome/chevron-right.svg", () => this.todas(false)))
          .child(
            div()
              .id("cv-refresh")
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.text_color(t.foreground))
              .tooltip("Atualizar")
              .on_click((_e, cx) => this.carregar(cx))
              .child(this.carregando ? "…" : "↻"),
          ),
      )
      // Com mais de uma máquina no herdr, um seletor troca de qual delas são as conversas.
      .when(maquinas.length > 1, (el) => el.child(h_flex().flex_none().px(10).pt(8).gap(4)
        .children(maquinas.map((m) => {
          const on = (m.name ?? null) === this.maquina;
          const fora = m.layout === "unavailable";
          return h_flex().id(`cvm-${m.name ?? "local"}`).flex_1().min_w(0).h(26).gap(6).px(8).items_center().justify_center().rounded(6)
            .border_1().border_color(on ? t.accent : t.border).bg(on ? t.raised : t.background)
            .text_size(12).text_color(on ? t.foreground : fora ? t.dim : t.muted)
            .when(!on, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
            .when(fora, (el) => el.tooltip(`${nomeMaquina(m.name)} está fora do ar`))
            .on_click((_e, cx) => this.trocarMaquina(m.name, cx))
            .child(svg(`mods/workspace-chrome/${m.name ? "server" : "monitor"}.svg`).size(12).flex_none())
            .child(div().truncate().child(nomeMaquina(m.name)));
        }))))
      // Esc no campo limpa a pesquisa.
      .child(h_flex().flex_none().px(10).py(8).border_b(1).border_color(t.border)
        .on_key_down((e, cx) => { if (e.key === "escape" && this.filtro) { this.busca.set_value(""); this.filtro = ""; cx.stop_propagation(); cx.notify(); } })
        .child(Input.new(this.busca).flex_1().h(28).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12.5)))
      .when(Boolean(this.erro), (el) => el.child(div().p(14).text_size(12).text_color(t.blocked).child(this.erro)))
      .when(!this.erro && filtrando && visiveis.length === 0 && this.grupos.length > 0, (el) =>
        el.child(div().p(14).text_size(12).text_color(t.dim).child(`Nenhuma conversa com “${this.filtro.trim()}”.`)))
      .when(!this.erro && this.grupos.length === 0, (el) =>
        el.child(div().p(14).text_size(12).text_color(t.dim).child(this.carregando ? "Lendo conversas…" : "Nenhuma conversa encontrada.")))
      .child(v_flex().id("cv-lista").flex_1().min_h(0).p(6).overflow_y_scrollbar().track_scroll(this.lista).children(visiveis.flatMap(grupo)));
  }
}
