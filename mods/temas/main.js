// Temas: usar, instalar e apagar layouts e temas de cor do herdr-app, e voltar ao padrão.
// Abre como diálogo (mod.open temas): pelo item "Temas" da barra lateral ou por ctrl-shift-y.
// O trabalho de disco e de rede fica no temas.py desta pasta; aqui é só a tela.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, run, theme, layouts, shared, props, closeOverlay, appHome, window, checking } from "herdr";

const DO_HERDR = { layouts: ["main", "terminals", "win98"], temas: ["graphite", "ink", "moss", "paper", "atom-one-dark"] };
// Padrão = o seu layout do dia a dia (com Conversas) e as cores de fábrica do Herdr.
const PADRAO_LAYOUT = () => (layouts().includes("main-conversas") ? "main-conversas" : "main");
const PYTHON = () => (window()?.platform === "windows" ? "python" : "python3");
const SCRIPT = () => `${appHome()}/mods/temas/temas.py`;

async function motor(...args) {
  const r = await exec(PYTHON(), [SCRIPT(), ...args], { timeout: 300000 });
  let out;
  try { out = JSON.parse(r.stdout); } catch { throw new Error(r.stderr.trim() || `temas.py saiu com ${r.code}`); }
  if (out.erro) throw new Error(out.erro);
  return out;
}

export default class Temas extends View {
  init(_props, cx) {
    this.dados = { layouts: [], temas: [], instalados: {} };
    this.link = "";
    this.previa = null;      // resultado do inspecionar, esperando confirmação
    this.ocupado = null;     // texto do que está rodando
    this.aviso = null;       // { texto, erro }
    this.confirmar = null;   // id que pediu "Apagar" e espera o segundo clique
    this.input = InputState.new({ value: "", placeholder: "herdr.dev/layouts/dono/nome, repositório do GitHub ou tema .json" });
    this.input.on("change", (_e, cx) => { this.link = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.inspecionar(cx));
    this.handle = cx.focus_handle();
    if (checking()) return;
    this.recarregar(cx);
  }

  tarefa(cx, texto, fn) {
    this.ocupado = texto;
    this.aviso = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await fn(); } catch (e) { this.aviso = { texto: String(e?.message ?? e), erro: true }; }
      this.ocupado = null;
      cx.notify();
    });
  }

  recarregar(cx) {
    cx.spawn(async (cx) => {
      try { this.dados = await motor("listar"); } catch (e) { this.aviso = { texto: String(e?.message ?? e), erro: true }; }
      cx.notify();
    });
  }

  // Instalado pelo Temas: o id no registro que traz este layout ou este tema.
  dono(tipo, nome) {
    return Object.entries(this.dados.instalados ?? {}).find(([, v]) => (tipo === "layout" ? v.layout === nome : (v.temas ?? []).includes(nome)))?.[0];
  }

  inspecionar(cx) {
    if (!this.link.trim() || this.ocupado) return;
    this.previa = null;
    this.tarefa(cx, "Baixando para conferir…", async () => { this.previa = await motor("inspecionar", this.link.trim()); });
  }

  instalar(cx) {
    const p = this.previa;
    this.tarefa(cx, "Instalando…", async () => {
      const r = await motor("instalar", p.id);
      this.previa = null;
      this.input.set_value("");
      this.link = "";
      this.dados = await motor("listar");
      if (r.layout) run("layout.switch", { name: r.layout });
      else if (r.temas?.[0]) run("app.theme", { name: r.temas[0] });
      this.aviso = { texto: `${r.layout ?? r.temas?.[0]} instalado${r.atalhos?.length ? " (com os atalhos dele)" : ""}.` };
    });
  }

  apagar(id, cx) {
    if (this.confirmar !== id) { this.confirmar = id; cx.notify(); return; }
    this.confirmar = null;
    const item = this.dados.instalados[id];
    // Apagar o layout que está na tela: antes volta para o padrão.
    if (item?.layout && item.layout === (shared("layout") ?? "main")) run("layout.switch", { name: PADRAO_LAYOUT() });
    this.tarefa(cx, "Apagando…", async () => {
      await motor("remover", id);
      this.dados = await motor("listar");
      this.aviso = { texto: `${item?.layout ?? id} apagado.` };
    });
  }

  padrao(cx) {
    run("layout.switch", { name: PADRAO_LAYOUT() });
    run("app.theme", { name: "graphite" });
    run("app.theme", { name: "paper" });
    this.aviso = { texto: `De volta ao padrão: layout ${PADRAO_LAYOUT()}, cores graphite (escuro) e paper (claro).` };
    cx.notify();
  }

  render() {
    const t = theme();
    const atual = shared("layout") ?? "main";
    const botao = (id, texto, tipo, acao) => h_flex().id(id).h(28).px(11).flex_none().items_center().rounded(7)
      .border_1().text_size(12).font_medium().cursor_pointer()
      .border_color(tipo === "primario" ? t.solid : tipo === "perigo" ? t.blocked : t.input)
      .bg(tipo === "primario" ? t.solid : tipo === "perigo" && this.confirmar ? t.blocked : t.raised)
      .text_color(tipo === "primario" ? t.solid_foreground : tipo === "perigo" ? (this.confirmar ? t.background : t.blocked) : t.foreground)
      .hover((s) => s.opacity(0.88)).on_click((_e, cx) => acao(cx)).child(texto);
    const titulo = (texto) => div().pt(16).pb(8).text_size(11.5).font_medium().text_color(t.dim).child(texto);
    const etiqueta = (texto, cor) => div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(cor ?? t.muted).child(texto);
    const apagarBotao = (id) => botao(`del-${id}`, this.confirmar === id ? "Confirmar" : "Apagar", "perigo", (cx) => this.apagar(id, cx));

    const linhaLayout = (nome) => {
      const id = this.dono("layout", nome);
      const origem = id ? this.dados.instalados[id].origem : null;
      return h_flex().id(`ly-${nome}`).h(40).px(10).gap(8).items_center().rounded(8)
        .when(nome === atual, (el) => el.bg(t.selected))
        .child(div().flex_none().text_size(13).text_color(t.foreground).child(nome))
        .child(etiqueta(DO_HERDR.layouts.includes(nome) ? "Herdr" : id ? "instalado" : "seu"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(origem ? origem.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") : ""))
        .child(nome === atual ? div().text_size(11.5).text_color(t.accent).child("em uso")
          : botao(`use-${nome}`, "Usar", null, () => run("layout.switch", { name: nome })))
        .when(Boolean(id), (el) => el.child(apagarBotao(id)));
    };

    // Tema com o nome de um layout é daquele layout (win98): só aparece quando ele está em uso.
    const temas = [...new Set([...DO_HERDR.temas, ...(this.dados.temas ?? [])])]
      .filter((n) => !(this.dados.layouts ?? []).includes(n) || n === atual);
    const chipTema = (nome) => {
      const id = this.dono("tema", nome);
      return h_flex().id(`tm-${nome}`).h(28).pl(10).pr(id ? 4 : 10).gap(6).items_center().rounded(14)
        .border_1().border_color(t.border).bg(t.raised).text_size(12).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip("Aplicar ao layout em uso")
        .on_click(() => run("app.theme", { name: nome }))
        .child(nome)
        .when(Boolean(id), (el) => el.child(div().id(`tmx-${nome}`).size(20).flex().items_center().justify_center().rounded(10)
          .text_color(this.confirmar === id ? t.blocked : t.dim).hover((s) => s.bg(t.hover).text_color(t.blocked))
          .tooltip(this.confirmar === id ? "Clique de novo para apagar" : "Apagar este tema")
          .on_click((_e, cx) => { cx.stop_propagation(); this.apagar(id, cx); })
          .child(svg("mods/workspace-chrome/x.svg").size(11))));
    };

    const p = this.previa;
    const previa = p && v_flex().mt(10).p(12).gap(6).rounded(9).border_1().border_color(t.border).bg(t.surface).text_size(12.5)
      .child(div().font_semibold().child(p.origem.replace(/^https:\/\/(github\.com|raw\.githubusercontent\.com)\//, "").replace(/\.git$/, "")))
      .child(div().text_color(t.muted).child([
        p.layouts.length ? `layout: ${p.layouts.join(", ")}` : null,
        p.mods.length ? `mods: ${p.mods.join(", ")}` : null,
        p.temas.length ? `cores: ${p.temas.join(", ")}` : null,
        `${p.mb} MB`,
      ].filter(Boolean).join(" · ")))
      .when(p.riscos.length > 0, (el) => el.child(div().text_color(t.blocked).child(`Atenção, o código dele ${p.riscos.join(", ")}.`)))
      .when(p.conflitos.length > 0, (el) => el.child(div().text_color(t.blocked).child(`Já existe com o mesmo nome: ${p.conflitos.join(", ")}. Apague ou renomeie antes.`)))
      .child(h_flex().pt(4).gap(8).justify_end()
        .child(botao("pv-cancel", "Cancelar", null, (cx) => { this.previa = null; cx.notify(); }))
        .when(p.conflitos.length === 0, (el) => el.child(botao("pv-ok", "Instalar", "primario", (cx) => this.instalar(cx)))));

    return v_flex().id("temas").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); } })
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .child(h_flex().px(18).pt(16).pb(4).items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Temas"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().id("temas-corpo").flex_1().min_h(0).px(18).overflow_y_scrollbar()
        .child(titulo("Layouts"))
        .children([...(this.dados.layouts ?? [])].sort((a, b) => (DO_HERDR.layouts.includes(b) - DO_HERDR.layouts.includes(a)) || a.localeCompare(b)).map(linhaLayout))
        .child(titulo("Cores do layout em uso"))
        .child(h_flex().flex_wrap().gap(6).children(temas.map(chipTema)))
        .child(titulo("Instalar"))
        .child(h_flex().gap(8).items_center()
          .child(Input.new(this.input).flex_1().h(32).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5))
          .child(botao("tm-ver", "Conferir", null, (cx) => this.inspecionar(cx))))
        .child(div().pt(6).text_size(11).text_color(t.dim).child("Ache layouts em herdr.dev/gallery. Antes de instalar o Temas baixa, mostra o que vem e o que o código faz."))
        .when(Boolean(previa), (el) => el.child(previa))
        .child(div().h(12)))
      .child(h_flex().px(18).py(12).gap(10).items_center().border_t(1).border_color(t.border)
        .child(botao("tm-padrao", "Voltar ao padrão", null, (cx) => this.padrao(cx)))
        .child(div().flex_1().min_w(0).truncate().text_size(12)
          .text_color(this.aviso?.erro ? t.blocked : t.muted)
          .child(this.ocupado ?? this.aviso?.texto ?? "")));
  }
}
