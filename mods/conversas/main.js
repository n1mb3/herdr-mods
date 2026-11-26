// Últimas conversas do Claude Code de cada pasta, abaixo de Agents.
// Clique retoma a conversa numa aba nova da pasta; botão direito copia o comando.
// A coleta é o conversas.py desta pasta, que o plugin do herdr de terminal
// (tui/ no repositório herdr-mods) também usa.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, InputState, Input } from "gpui-base";
import { exec, spaces, panes, run, theme, notify, checking, appHome, window, props, openOverlay, closeOverlay } from "herdr";

// Mesmo main.js no Windows e no Linux: só o Python muda.
const WINDOWS = () => window()?.platform === "windows";
const SCRIPT = () => `${appHome()}/mods/conversas/conversas.py`;
const PYTHON = () => (WINDOWS() ? "python" : "python3");
const COMANDO = (id) => `claude --dangerously-skip-permissions --resume ${id}`;
const ATUALIZA_MS = 30000;
const POR_PAGINA = 2;   // conversas por página em cada pasta
const LIMITE = 50;      // conversas por pasta pedidas ao coletor (as mais recentes)

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

// Aba nova no space que já está nessa pasta; senão, um space novo nela.
function retomar(c) {
  const argv = ["claude", "--dangerously-skip-permissions", "--resume", c.id];
  const alvo = norm(c.cwd);
  const todos = spaces();
  const aba = panes().find((p) => norm(p.cwd) === alvo)?.tab;
  const porPainel = aba && todos.find((s) => s.tabs.some((t) => t.id === aba))?.id;
  const space = porPainel ?? todos.find((s) => norm(s.folder) === alvo)?.id;
  if (space) run("tab.new", { space, folder: c.cwd, argv, name: c.titulo.slice(0, 24) });
  else run("space.new", { folder: c.cwd, argv });
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
      if (!checking()) this.lerFalas(cx);
      return;
    }
    this.grupos = [];
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
    // Pastas recolhidas e página de cada pasta: ficam guardadas entre aberturas.
    let estado = {};
    try { estado = JSON.parse(localStorage.getItem("estado") ?? "{}") ?? {}; } catch { estado = {}; }
    this.fechados = new Set(Array.isArray(estado.fechados) ? estado.fechados : []);
    this.paginas = estado.paginas && typeof estado.paginas === "object" ? estado.paginas : {};
    if (checking()) return;
    this.carregar(cx);
    cx.timer.every(ATUALIZA_MS, (cx) => this.carregar(cx));
  }

  salvar() {
    localStorage.setItem("estado", JSON.stringify({ fechados: [...this.fechados], paginas: this.paginas }));
  }

  // Todas abertas ou todas fechadas, inclusive as que ainda não apareceram (chaves = pastas).
  todas(abrir) {
    this.fechados = abrir ? new Set() : new Set(this.grupos.map((g) => g.cwd));
    this.salvar();
  }

  carregar(cx) {
    if (this.carregando) return;
    this.carregando = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(PYTHON(), [SCRIPT(), "--listar", "--limite", String(LIMITE)], { timeout: 60000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `saiu com ${r.code}`);
        this.grupos = JSON.parse(r.stdout);
        this.erro = null;
      } catch (e) {
        this.erro = String(e?.message ?? e);
      }
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
      const r = await exec(PYTHON(), [SCRIPT(), "--renomear", id, novo], { timeout: 30000 });
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
        const r = await exec(PYTHON(), [SCRIPT(), "--ultimas", props().conversa.id], { timeout: 30000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `saiu com ${r.code}`);
        this.falas = JSON.parse(r.stdout);
        // Abre no fim, que é a parte mais recente.
        if (this.falas.length) this.rolagem.scroll_to_item(this.falas.length - 1);
      } catch (e) {
        this.erro = String(e?.message ?? e);
      }
      cx.notify();
    });
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
          .child(div().truncate().text_size(11).text_color(t.dim).child(`${c.pasta} · ${c.id}`)))
        .child(div().text_size(11).text_color(t.dim).child("Esc"))
        .child(this.acao(t, "cv-modal-fechar", "Fechar", "mods/workspace-chrome/x.svg", () => closeOverlay(props().overlay))))
      .when(Boolean(this.erro), (el) => el.child(aviso(this.erro, t.blocked)))
      .when(!this.erro && !this.falas, (el) => el.child(aviso("Lendo a conversa…", t.dim)))
      .when(!this.erro && this.falas?.length === 0, (el) => el.child(aviso("Nenhuma fala de texto nesta conversa.", t.dim)))
      .child(v_flex().id("cv-falas").flex_1().min_h(0).p(14).gap(8).overflow_y_scrollbar().track_scroll(this.rolagem)
        .children((this.falas ?? []).map(fala)));
  }

  acao(t, id, dica, icone, fazer) {
    return div().id(id).size(22).flex().items_center().justify_center().rounded(5).text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(dica)
      .on_click((_e, cx) => { fazer(); cx.notify(); }).child(svg(icone).size(12));
  }

  render(cx) {
    const t = theme();
    if (props()?.conversa) return this.modal(t);
    // Ícone que abre o modal das últimas falas, sem retomar a conversa.
    const ver = (c) => div().id(`cvv-${c.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.background).text_color(t.foreground))
      .tooltip("Ver as últimas falas")
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "conversas", kind: "dialog", width: 720, height: 620, // Só o nome da pasta: as props do overlay perdem as barras invertidas do caminho.
          props: { conversa: { id: c.id, titulo: c.titulo, pasta: nome(c.cwd) } } });
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
          .on_click(() => retomar(c)))
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
    const visiveis = filtrando
      ? this.grupos.map((g) => ({ ...g, conversas: g.conversas.filter((c) => bate(g, c)) })).filter((g) => g.conversas.length)
      : this.grupos;

    const grupo = (g) => {
      const aberto = filtrando || !this.fechados.has(g.cwd);
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
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .text_size(12.5)
          .font_semibold()
          .text_color(t.foreground)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(g.cwd)
          .on_click((_e, cx) => {
            aberto ? this.fechados.add(g.cwd) : this.fechados.delete(g.cwd);
            this.salvar();
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
      // Esc no campo limpa a pesquisa.
      .child(h_flex().flex_none().px(10).py(8).border_b(1).border_color(t.border)
        .on_key_down((e, cx) => { if (e.key === "escape" && this.filtro) { this.busca.set_value(""); this.filtro = ""; cx.stop_propagation(); cx.notify(); } })
        .child(Input.new(this.busca).flex_1().h(28).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12.5)))
      .when(Boolean(this.erro), (el) => el.child(div().p(14).text_size(12).text_color(t.blocked).child(this.erro)))
      .when(!this.erro && filtrando && visiveis.length === 0 && this.grupos.length > 0, (el) =>
        el.child(div().p(14).text_size(12).text_color(t.dim).child(`Nenhuma conversa com “${this.filtro.trim()}”.`)))
      .when(!this.erro && this.grupos.length === 0, (el) =>
        el.child(div().p(14).text_size(12).text_color(t.dim).child(this.carregando ? "Lendo conversas…" : "Nenhuma conversa encontrada.")))
      .child(v_flex().id("cv-lista").flex_1().min_h(0).p(6).overflow_y_scrollbar().children(visiveis.flatMap(grupo)));
  }
}
