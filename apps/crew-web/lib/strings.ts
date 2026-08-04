// Crew app — ES/EN bilingual strings.
// Spanish is kitchen Spanish (Spanglish): "merma" not "desperdicio",
// retain English kitchen terms where ubiquitous ("walk-in", "prep").

import type { WriteFailure } from "./api";
import type { Lang } from "./types";

export type StringKey =
  | "appName"
  | "storeName"
  | "pin_title"
  | "pin_hint"
  | "pin_wrong"
  | "pin_clear"
  | "pin_logout_auto"
  | "pin_session_expired"
  | "pin_blocked"
  | "hi"
  | "home_subtitle"
  | "btn_waste"
  | "btn_waste_sub"
  | "btn_receive"
  | "btn_receive_sub"
  | "btn_86"
  | "btn_86_sub"
  | "btn_count"
  | "btn_count_sub"
  | "btn_recount"
  | "btn_recount_sub"
  | "btn_additem"
  | "btn_additem_sub"
  | "btn_edititem"
  | "btn_edititem_sub"
  | "logout"
  | "switch_user"
  | "waste_step1"
  | "waste_step2"
  | "waste_step3"
  | "waste_step4"
  | "waste_pick_title"
  | "waste_pick_search"
  | "waste_pick_scan"
  | "waste_qty_title"
  | "waste_qty_unit"
  | "waste_reason_title"
  | "waste_photo_title"
  | "waste_photo_take"
  | "waste_photo_attached"
  | "waste_photo_skip"
  | "waste_photo_required"
  | "waste_review"
  | "waste_save"
  | "waste_saved"
  | "waste_saved_sub"
  | "waste_done"
  | "rsn_spoilage"
  | "rsn_prep"
  | "rsn_cook"
  | "rsn_return"
  | "rsn_quality"
  | "rsn_drop"
  | "rsn_theft"
  | "rsn_over"
  | "receive_title"
  | "receive_subtitle"
  | "receive_lines"
  | "receive_expected"
  | "receive_received"
  | "receive_short"
  | "receive_check_all"
  | "receive_finish"
  | "e86_title"
  | "e86_subtitle"
  | "e86_empty"
  | "e86_unflag"
  | "recount_pick"
  | "recount_qty"
  | "recount_was"
  | "recount_save"
  | "recount_saved"
  | "recount_saved_sub"
  | "additem_title"
  | "additem_save"
  | "additem_saved"
  | "additem_saved_sub"
  | "edititem_title"
  | "edititem_pick"
  | "edititem_save"
  | "edititem_saved"
  | "edititem_saved_sub"
  | "edititem_photo"
  | "edititem_photo_add"
  | "edititem_photo_change"
  | "edititem_photo_remove"
  | "back"
  | "next"
  | "cancel"
  | "confirm"
  | "qty_short"
  | "welcome"
  | "welcome_m"
  | "pin_locked"
  | "loading"
  | "data_error"
  | "retry"
  | "save_error"
  | "save_error_session"
  | "save_error_offline"
  | "save_error_unavailable"
  | "save_error_timeout"
  | "e86_mark"
  // -- Redesign: home groups + tiles -----------------------------------------
  | "group_mov"
  | "group_cat"
  | "scan_hero"
  | "scan_hero_sub"
  | "scan_hero_cta"
  | "mov_receive"
  | "mov_receive_sub"
  | "mov_waste"
  | "mov_waste_sub"
  | "mov_recount"
  | "mov_recount_sub"
  | "cat_items"
  | "cat_items_sub"
  | "count_items"
  | "count_critical"
  // -- Redesign: scan flow ----------------------------------------------------
  | "scan_cap_h"
  | "scan_cap_p"
  | "scan_take"
  | "scan_upload"
  | "scan_cap_hint"
  | "scan_analyzing"
  | "scan_analyzing_step"
  | "scan_recognized"
  | "scan_check_all"
  | "scan_review_p"
  | "scan_onhand"
  | "scan_price_up"
  | "scan_update_price"
  | "scan_new_sku"
  | "scan_remembered"
  | "scan_ai"
  | "scan_by_pack"
  | "scan_pack"
  | "scan_new_details"
  | "scan_map_to"
  | "scan_create"
  | "scan_pack_label"
  | "scan_pack_label_ph"
  | "scan_pack_qty"
  | "scan_pack_needed"
  | "scan_grouped"
  | "scan_grouped_hint"
  | "scan_split"
  | "scan_import"
  | "scan_succ_h"
  | "scan_succ_one"
  | "scan_succ_many"
  | "scan_error"
  | "scan_retry"
  | "scan_leave_title"
  | "scan_leave_body"
  | "scan_leave_stay"
  | "scan_leave_discard"
  | "home_refresh"
  // -- Redesign: shared field labels + generic actions ------------------------
  | "done"
  | "f_name"
  | "f_price"
  | "f_category"
  | "f_unit"
  | "f_unit_kind"
  | "unit_kind_count"
  | "unit_kind_weight"
  | "unit_kind_volume"
  | "f_par"
  | "f_par_max"
  | "f_par_max_hint"
  | "f_vendor"
  | "f_optional"
  // -- Redesign: Artículos list + detail/edit ---------------------------------
  | "items_sub"
  | "items_search_ph"
  | "items_code_lookup"
  | "items_code_not_found"
  | "items_scan_camera"
  | "scan_cam_title"
  | "scan_cam_hint"
  | "scan_cam_denied"
  | "scan_cam_nocam"
  | "scan_cam_error"
  | "scan_cam_type_instead"
  | "pack_by_unit"
  | "pack_count_unit"
  | "items_all"
  | "items_none"
  | "items_new"
  | "it_edit"
  | "it_save"
  | "it_apply"
  | "it_in_stock"
  | "it_status_critical"
  | "it_status_low"
  | "it_status_ok"
  | "it_act_86"
  | "it_act_un86"
  | "it_recount_set"
  | "it_waste_sub"
  | "it_act_receive"
  | "it_receive_sub"
  | "it_create"
  // -- Items: ＋New "Add item" chooser (scan barcode vs enter manually) --------
  | "add_title"
  | "add_scan"
  | "add_scan_sub"
  | "add_manual"
  | "add_manual_sub"
  // -- Redesign: rebuilt Recibir ----------------------------------------------
  | "rcv_title"
  | "rcv_sub"
  | "rcv_intransit"
  | "rcv_expected"
  | "rcv_checkall"
  | "rcv_ok"
  | "rcv_short"
  | "rcv_received"
  | "rcv_finish"
  | "rcv_done"
  | "rcv_updated"
  | "rcv_none"
  // -- Redesign: rebuilt Merma ------------------------------------------------
  | "wst_title"
  | "wst_pick"
  | "wst_qty"
  | "wst_register"
  | "wst_done"
  // -- Redesign: rebuilt Reconteo ---------------------------------------------
  | "rco_title"
  | "rco_sub"
  | "rco_system"
  | "rco_save"
  | "rco_done"
  | "rco_count"
  // -- Item icon (emoji) picker + delete --------------------------------------
  | "edititem_icon"
  | "edititem_icon_change"
  | "icon_picker_title"
  | "icon_picker_clear"
  | "icon_grp_drinks"
  | "icon_grp_dairy"
  | "icon_grp_fruit"
  | "icon_grp_veg"
  | "icon_grp_food"
  | "icon_grp_bakery"
  | "icon_grp_toppings"
  | "icon_grp_packaging"
  | "icon_grp_supplies"
  | "icon_grp_symbols"
  | "it_delete"
  | "it_delete_q"
  | "it_delete_note"
  | "it_delete_yes"
  // -- Redesign: Artículos multi-select + batch delete + undo ------------------
  | "undo"
  | "it_select"
  | "it_select_all"
  | "it_deselect_all"
  | "it_sel_title"
  | "it_sel_tap"
  | "it_sel_n"
  | "it_sel_more"
  | "it_del_n"
  | "it_del_confirm_one"
  | "it_del_confirm_many"
  | "it_del_confirm_btn_one"
  | "it_del_confirm_btn_many"
  | "it_del_note"
  | "it_deleted_one"
  | "it_deleted_many"
  // -- Redesign: Artículos empty states ---------------------------------------
  | "it_empty_results_s"
  | "it_empty_clear"
  | "it_empty_filter_t"
  | "it_empty_filter_s"
  | "it_empty_show_all"
  | "it_empty_none"
  // -- Redesign: flow undo (Merma / Reconteo) ---------------------------------
  | "flow_undone"
  // -- Redesign: offline / connectivity indicator -----------------------------
  | "net_online"
  | "net_offline"
  | "net_offline_banner"
  | "net_back_online"
  // -- §8: Scan barcode stock-adjust flow -------------------------------------
  | "scan_pull_tile"
  | "scan_pull_tile_sub"
  | "scan_found"
  | "scan_adjust_hint"
  | "scan_sub_btn"
  | "scan_add_btn"
  | "scan_apply_zero"
  | "scan_pull_done"
  // §8: unknown-code → offer to register the item right from the adjust scanner
  | "scan_add_q"
  | "scan_add_cta"
  | "scan_add_dismiss"
  | "sr_btn"
  | "sr_title"
  | "sr_scan_cta"
  | "sr_manual"
  | "sr_lookup"
  | "sr_searching"
  | "sr_already"
  | "sr_scan_next"
  | "sr_found"
  | "sr_new"
  | "sr_name"
  | "sr_category"
  | "sr_unit"
  | "sr_pack"
  | "sr_pack_qty"
  | "sr_register"
  | "sr_saving"
  | "sr_saved"
  | "sr_error"
  | "sr_recv_q"
  | "sr_recv"
  | "sr_skip"
  | "sr_in"
  | "sr_recv_later";

// Map a write/scan failure (lib/api `WriteFailure`) to its localized message key.
// Centralized so a new failure variant lights up in EVERY flow at once — the
// per-flow ternaries that used to inline this silently dropped unmapped reasons to
// the generic fallback, which is exactly how 502/503 ("service down") wrongly read
// as "offline" ("check your internet"). `server` stays context-specific, so the
// caller passes its own fallback (scan's analyze step wants `scan_error`).
export function writeFailureKey(
  reason: WriteFailure,
  fallback: StringKey = "save_error"
): StringKey {
  switch (reason) {
    case "session":
      return "save_error_session";
    case "offline":
      return "save_error_offline";
    case "unavailable":
      return "save_error_unavailable";
    case "timeout":
      return "save_error_timeout";
    case "server":
      return fallback;
  }
}

export const STRINGS: Record<Lang, Record<StringKey, string>> = {
  es: {
    appName: "Crew",
    storeName: "Anytown · Anytown",

    pin_title: "Hola, identifícate",
    pin_hint: "Ingresa tu PIN de 6 dígitos",
    pin_wrong: "PIN incorrecto, intenta de nuevo",
    pin_clear: "Borrar",
    pin_logout_auto: "Cierre automático en {n}s",
    pin_session_expired: "Tu sesión expiró. Vuelve a entrar con tu PIN.",
    pin_blocked: "Esta red no está autorizada. Avisa al gerente.",

    hi: "Hola",
    home_subtitle: "¿Qué necesitas hacer?",
    btn_waste: "Registrar merma",
    btn_waste_sub: "Algo se tiró o se dañó",
    btn_receive: "Recibir pedido",
    btn_receive_sub: "Llegó camión de proveedor",
    btn_86: "Lista 86",
    btn_86_sub: "Ver lo que está agotado",
    btn_count: "Hacer conteo",
    btn_count_sub: "Contar lo que hay en la mesa",
    btn_recount: "Re-conteo rápido",
    btn_recount_sub: "Actualizar un artículo",
    btn_additem: "Agregar artículo",
    btn_additem_sub: "Algo nuevo que no está",
    btn_edititem: "Editar artículo",
    btn_edititem_sub: "Cambiar nombre, foto o unidad",
    logout: "Salir",
    switch_user: "Cambiar usuario",

    waste_step1: "Artículo",
    waste_step2: "Cantidad",
    waste_step3: "Motivo",
    waste_step4: "Foto",
    waste_pick_title: "¿Qué se tiró?",
    waste_pick_search: "Buscar o escanear código…",
    waste_pick_scan: "Escanear código",
    waste_qty_title: "¿Cuánto?",
    waste_qty_unit: "unidad",
    waste_reason_title: "¿Por qué?",
    waste_photo_title: "¿Tienes foto?",
    waste_photo_take: "Tomar foto",
    waste_photo_attached: "Foto adjunta",
    waste_photo_skip: "Sin foto",
    waste_photo_required: "Foto obligatoria para mermas mayores a {amt}",
    waste_review: "Revisar",
    waste_save: "Guardar merma",
    waste_saved: "¡Listo! Merma registrada",
    waste_saved_sub: "Inventario actualizado · gracias",
    waste_done: "Hecho",

    rsn_spoilage: "Caducidad",
    rsn_prep: "Error preparando",
    rsn_cook: "Se quemó",
    rsn_return: "Devolución cliente",
    rsn_quality: "Mala calidad",
    rsn_drop: "Se cayó",
    rsn_theft: "Pérdida",
    rsn_over: "Sobra de turno",

    receive_title: "Recibir pedido",
    receive_subtitle: "Toca el pedido que está llegando",
    receive_lines: "líneas",
    receive_expected: "esperado hoy",
    receive_received: "Recibido completo",
    receive_short: "Faltan piezas",
    receive_check_all: "Marcar todo OK",
    receive_finish: "Terminar entrega",

    e86_title: "Lista 86 — agotado",
    e86_subtitle: "Estos artículos no se pueden vender",
    e86_empty: "Nada agotado por ahora",
    e86_unflag: "Volver a vender",

    recount_pick: "¿Qué vas a re-contar?",
    recount_qty: "¿Cuánto hay ahora?",
    recount_was: "Sistema dice",
    recount_save: "Guardar conteo",
    recount_saved: "Conteo actualizado",
    recount_saved_sub: "Gracias por avisar",

    additem_title: "Artículo nuevo",
    additem_save: "Agregar artículo",
    additem_saved: "¡Artículo agregado!",
    additem_saved_sub: "Ya puedes registrar merma o conteo",

    edititem_title: "Editar artículo",
    edititem_pick: "¿Qué artículo vas a editar?",
    edititem_save: "Guardar cambios",
    edititem_saved: "¡Artículo actualizado!",
    edititem_saved_sub: "Los cambios ya están guardados",
    edititem_photo: "Foto",
    edititem_photo_add: "Agregar foto",
    edititem_photo_change: "Cambiar foto",
    edititem_photo_remove: "Quitar foto",

    back: "Atrás",
    next: "Siguiente",
    cancel: "Cancelar",
    confirm: "Confirmar",
    qty_short: "cant",
    welcome: "Bienvenida",
    welcome_m: "Bienvenido",
    pin_locked: "Demasiados intentos. Espera un momento.",
    loading: "Cargando…",
    data_error: "No se pudo cargar el inventario.",
    retry: "Reintentar",
    save_error: "No se pudo guardar. Intenta otra vez.",
    save_error_session: "Tu sesión expiró. Vuelve a entrar con tu PIN.",
    save_error_offline: "Sin conexión. Revisa el internet e intenta otra vez.",
    save_error_unavailable: "Servicio no disponible. Avisa a tu gerente.",
    save_error_timeout: "Tardó demasiado. Intenta de nuevo.",
    e86_mark: "Marcar 86",

    group_mov: "Movimientos",
    group_cat: "Catálogo",
    scan_hero: "Escanear factura",
    scan_hero_sub: "Toma una foto y la IA registra todo en segundos",
    scan_hero_cta: "Escanear",
    mov_receive: "Recibir",
    mov_receive_sub: "Entrada de pedido",
    mov_waste: "Merma",
    mov_waste_sub: "Registrar desperdicio",
    mov_recount: "Reconteo",
    mov_recount_sub: "Ajustar conteo",
    cat_items: "Artículos",
    cat_items_sub: "Buscar, editar par/precio, 86",
    count_items: "artículos",
    count_critical: "crítico",

    scan_cap_h: "Escanea la factura",
    scan_cap_p: "Toma una foto del ticket o súbela. La IA reconoce artículos, cantidades y precios.",
    scan_take: "Tomar foto",
    scan_upload: "Subir archivo",
    scan_cap_hint: "Foto o PDF nítido · toda la factura en cuadro",
    scan_analyzing: "Analizando con IA",
    scan_analyzing_step: "Reconociendo artículos, cantidades y precios…",
    scan_recognized: "artículos reconocidos",
    scan_check_all: "Marcar todo",
    scan_review_p: "Revisa cantidades y precios, luego confirma. Puedes editar o quitar cualquier línea.",
    scan_onhand: "en mano",
    scan_price_up: "Cambio de precio",
    scan_update_price: "Actualizar precio",
    scan_new_sku: "Nuevo",
    scan_remembered: "recordado",
    scan_ai: "IA",
    scan_by_pack: "por",
    scan_pack: "caja",
    scan_new_details: "Datos del nuevo artículo",
    scan_map_to: "Asignar a",
    scan_create: "Crear",
    scan_pack_label: "Tamaño / empaque",
    scan_pack_label_ph: "p. ej. bolsa 28 oz",
    scan_pack_qty: "Cantidad base por empaque",
    scan_pack_needed: "Indica la cantidad base de este tamaño.",
    scan_grouped: "Mismo artículo",
    scan_grouped_hint: "varios tamaños → un artículo con empaques",
    scan_split: "Separar",
    scan_import: "Importar al inventario",
    scan_succ_h: "¡Inventario actualizado!",
    scan_succ_one: "artículo importado",
    scan_succ_many: "artículos importados",
    scan_error: "No se pudo leer la factura. Intenta otra vez.",
    scan_retry: "Reintentar",
    scan_leave_title: "¿Salir sin guardar?",
    scan_leave_body: "Los cambios de esta factura no se han importado y se perderán.",
    scan_leave_stay: "Seguir editando",
    scan_leave_discard: "Descartar cambios",
    home_refresh: "Actualizar",

    done: "Listo",
    f_name: "Nombre",
    f_price: "Precio unit.",
    f_category: "Categoría",
    f_unit: "Unidad",
    f_unit_kind: "Tipo de unidad",
    unit_kind_count: "Conteo",
    unit_kind_weight: "Peso",
    unit_kind_volume: "Volumen",
    f_par: "Par mín.",
    f_par_max: "Par máx.",
    f_par_max_hint: "Par máx. debe ser ≥ par mín.",
    f_vendor: "Proveedor",
    f_optional: "opcional",

    items_sub: "Toca un artículo para editar o ajustar.",
    items_search_ph: "Buscar artículo o SKU…",
    items_code_lookup: "Buscar por código",
    items_code_not_found: "Código no encontrado",
    items_scan_camera: "Escanear con cámara",
    scan_cam_title: "Escanea el código",
    scan_cam_hint: "Apunta la cámara al código de barras",
    scan_cam_denied: "Permite el acceso a la cámara para escanear",
    scan_cam_nocam: "No hay cámara disponible",
    scan_cam_error: "No se pudo abrir la cámara",
    scan_cam_type_instead: "Escribir código",
    pack_by_unit: "Por unidad",
    pack_count_unit: "paquetes",
    items_all: "Todos",
    items_none: "Sin resultados",
    items_new: "Nuevo artículo",
    it_edit: "Editar",
    it_save: "Guardar",
    it_apply: "Aplicar",
    it_in_stock: "En mano",
    it_status_critical: "Crítico",
    it_status_low: "Bajo",
    it_status_ok: "OK",
    it_act_86: "Marcar 86",
    it_act_un86: "Quitar 86",
    it_recount_set: "Conteo real",
    it_waste_sub: "Descontar",
    it_act_receive: "Recibir",
    it_receive_sub: "¿Cuánto llegó?",
    it_create: "Crear artículo",
    add_title: "Agregar artículo",
    add_scan: "Escanear código",
    add_scan_sub: "Escanea un paquete y lo pre-llenamos",
    add_manual: "Ingresar manualmente",
    add_manual_sub: "Escribe los datos tú mismo",

    rcv_title: "Recibir",
    rcv_sub: "Pedidos en camino",
    rcv_intransit: "en camino",
    rcv_expected: "Esperado",
    rcv_checkall: "Todo OK",
    rcv_ok: "OK",
    rcv_short: "Falta",
    rcv_received: "Recibido",
    rcv_finish: "Confirmar recepción",
    rcv_done: "¡Entrega registrada!",
    rcv_updated: "Inventario actualizado",
    rcv_none: "No hay pedidos abiertos",

    wst_title: "Merma",
    wst_pick: "¿Qué se desperdició?",
    wst_qty: "Cantidad",
    wst_register: "Registrar merma",
    wst_done: "¡Merma registrada!",

    rco_title: "Reconteo",
    rco_sub: "Cuenta y ajusta el stock real",
    rco_system: "Sistema",
    rco_save: "Guardar conteo",
    rco_done: "¡Conteo guardado!",
    rco_count: "contados",

    edititem_icon: "Ícono",
    edititem_icon_change: "Toca para cambiar el ícono",
    icon_picker_title: "Elegir ícono",
    icon_picker_clear: "Usar ícono predeterminado",
    icon_grp_drinks: "Bebidas",
    icon_grp_dairy: "Lácteos y helado",
    icon_grp_fruit: "Fruta",
    icon_grp_veg: "Verduras",
    icon_grp_food: "Comida",
    icon_grp_bakery: "Pan y panadería",
    icon_grp_toppings: "Toppings y dulces",
    icon_grp_packaging: "Empaque",
    icon_grp_supplies: "Suministros",
    icon_grp_symbols: "Símbolos",
    it_delete: "Eliminar artículo",
    it_delete_q: "¿Eliminar este artículo?",
    it_delete_note:
      "Se ocultará del inventario activo. El historial se conserva y el gerente puede restaurarlo.",
    it_delete_yes: "Sí, eliminar",

    undo: "Deshacer",
    it_select: "Seleccionar",
    it_select_all: "Seleccionar todo",
    it_deselect_all: "Quitar selección",
    it_sel_title: "Seleccionar artículos",
    it_sel_tap: "Toca para seleccionar.",
    it_sel_n: "{n} seleccionados",
    it_sel_more: "Toca más para agregar, o usa la barra de abajo.",
    it_del_n: "Eliminar {n}",
    it_del_confirm_one: "¿Eliminar 1 artículo?",
    it_del_confirm_many: "¿Eliminar {n} artículos?",
    it_del_confirm_btn_one: "Eliminar 1 artículo",
    it_del_confirm_btn_many: "Eliminar {n} artículos",
    it_del_note:
      "Esto archiva los artículos seleccionados de la lista activa. El gerente puede restaurarlos después desde Backoffice.",
    it_deleted_one: "1 artículo eliminado",
    it_deleted_many: "{n} artículos eliminados",

    it_empty_results_s: "Ningún artículo coincide con “{q}”",
    it_empty_clear: "Borrar búsqueda",
    it_empty_filter_t: "Nada por aquí",
    it_empty_filter_s: "No hay artículos en este filtro.",
    it_empty_show_all: "Ver todos",
    it_empty_none: "Aún no hay artículos.",

    flow_undone: "Cambio deshecho",

    net_online: "En línea",
    net_offline: "Sin conexión",
    net_offline_banner:
      "Sin conexión — puedes seguir navegando. Para guardar, espera a reconectar.",
    net_back_online: "De nuevo en línea",

    scan_pull_tile: "Escanear código",
    scan_pull_tile_sub: "Resta lo que tomaste",
    scan_found: "Artículo encontrado",
    scan_adjust_hint: "− lo que tomaste · + lo que recibiste",
    scan_sub_btn: "Restar",
    scan_add_btn: "Agregar",
    scan_apply_zero: "Elige una cantidad",
    scan_pull_done: "Stock actualizado",
    scan_add_q: "Este código no está registrado. ¿Agregarlo como artículo nuevo?",
    scan_add_cta: "Agregar artículo",
    scan_add_dismiss: "Seguir escaneando",

    sr_btn: "Escanear",
    sr_title: "Escanear para agregar",
    sr_scan_cta: "Escanear código",
    sr_manual: "O escribe el código",
    sr_lookup: "Buscar",
    sr_searching: "Buscando…",
    sr_already: "Ya está registrado",
    sr_scan_next: "Escanear otro",
    sr_found: "encontrado — revisa",
    sr_new: "nuevo — completa los datos",
    sr_name: "Nombre",
    sr_category: "Categoría",
    sr_unit: "Unidad",
    sr_pack: "Paquete (opcional)",
    sr_pack_qty: "Unid. / paquete",
    sr_register: "Registrar",
    sr_saving: "Guardando…",
    sr_saved: "¡Registrado!",
    sr_error: "No se pudo guardar. Intenta de nuevo.",
    sr_recv_q: "¿Cuánto recibiste?",
    sr_recv: "Recibir",
    sr_skip: "Omitir",
    sr_in: "En",
    sr_recv_later: "Recibir después",
  },

  en: {
    appName: "Crew",
    storeName: "Anytown · Anytown",

    pin_title: "Hi, sign in",
    pin_hint: "Enter your 6-digit PIN",
    pin_wrong: "Wrong PIN — try again",
    pin_clear: "Clear",
    pin_logout_auto: "Auto sign-out in {n}s",
    pin_session_expired: "Your session expired. Sign in again with your PIN.",
    pin_blocked: "This network isn't allowed. Ask your manager.",

    hi: "Hi",
    home_subtitle: "What do you need to do?",
    btn_waste: "Record waste",
    btn_waste_sub: "Something dropped or spoiled",
    btn_receive: "Receive order",
    btn_receive_sub: "Truck just arrived",
    btn_86: "86 list",
    btn_86_sub: "See what's out",
    btn_count: "Run a count",
    btn_count_sub: "Count what's on the line",
    btn_recount: "Quick recount",
    btn_recount_sub: "Update one item",
    btn_additem: "Add item",
    btn_additem_sub: "Something new that's missing",
    btn_edititem: "Edit item",
    btn_edititem_sub: "Change name, photo or unit",
    logout: "Sign out",
    switch_user: "Switch user",

    waste_step1: "Item",
    waste_step2: "Quantity",
    waste_step3: "Reason",
    waste_step4: "Photo",
    waste_pick_title: "What got tossed?",
    waste_pick_search: "Search or scan code…",
    waste_pick_scan: "Scan code",
    waste_qty_title: "How much?",
    waste_qty_unit: "unit",
    waste_reason_title: "Why?",
    waste_photo_title: "Got a photo?",
    waste_photo_take: "Take photo",
    waste_photo_attached: "Photo attached",
    waste_photo_skip: "No photo",
    waste_photo_required: "Photo required for waste over {amt}",
    waste_review: "Review",
    waste_save: "Save waste",
    waste_saved: "Done — waste recorded",
    waste_saved_sub: "Inventory updated · thanks",
    waste_done: "OK",

    rsn_spoilage: "Spoiled / expired",
    rsn_prep: "Prep error",
    rsn_cook: "Burned / overcooked",
    rsn_return: "Customer return",
    rsn_quality: "Bad quality",
    rsn_drop: "Dropped",
    rsn_theft: "Loss",
    rsn_over: "Overproduction",

    receive_title: "Receive order",
    receive_subtitle: "Tap the order that arrived",
    receive_lines: "lines",
    receive_expected: "due today",
    receive_received: "Received in full",
    receive_short: "Items missing",
    receive_check_all: "Mark all OK",
    receive_finish: "Finish receiving",

    e86_title: "86 list — out of stock",
    e86_subtitle: "These items can't be sold",
    e86_empty: "Nothing 86'd right now",
    e86_unflag: "Back on the menu",

    recount_pick: "What did you re-check?",
    recount_qty: "How much is there now?",
    recount_was: "System says",
    recount_save: "Save count",
    recount_saved: "Count updated",
    recount_saved_sub: "Thanks for the heads-up",

    additem_title: "New item",
    additem_save: "Add item",
    additem_saved: "Item added!",
    additem_saved_sub: "Ready to count or record waste",

    edititem_title: "Edit item",
    edititem_pick: "Which item do you want to edit?",
    edititem_save: "Save changes",
    edititem_saved: "Item updated!",
    edititem_saved_sub: "Your changes are saved",
    edititem_photo: "Photo",
    edititem_photo_add: "Add photo",
    edititem_photo_change: "Change photo",
    edititem_photo_remove: "Remove photo",

    back: "Back",
    next: "Next",
    cancel: "Cancel",
    confirm: "Confirm",
    qty_short: "qty",
    welcome: "Welcome",
    welcome_m: "Welcome",
    pin_locked: "Too many attempts. Wait a moment.",
    loading: "Loading…",
    data_error: "Couldn't load inventory.",
    retry: "Retry",
    save_error: "Couldn't save. Try again.",
    save_error_session: "Your session expired. Sign in again with your PIN.",
    save_error_offline: "No connection. Check the internet and try again.",
    save_error_unavailable: "Service unavailable. Tell your manager.",
    save_error_timeout: "Took too long. Try again.",
    e86_mark: "Mark 86",

    group_mov: "Movements",
    group_cat: "Catalog",
    scan_hero: "Scan invoice",
    scan_hero_sub: "Snap a photo and AI logs everything in seconds",
    scan_hero_cta: "Scan",
    mov_receive: "Receive",
    mov_receive_sub: "Order intake",
    mov_waste: "Waste",
    mov_waste_sub: "Log waste",
    mov_recount: "Recount",
    mov_recount_sub: "Adjust count",
    cat_items: "Items",
    cat_items_sub: "Search, edit par/price, 86",
    count_items: "items",
    count_critical: "critical",

    scan_cap_h: "Scan the invoice",
    scan_cap_p: "Take a photo of the receipt or upload it. AI reads items, quantities and prices.",
    scan_take: "Take photo",
    scan_upload: "Upload file",
    scan_cap_hint: "Sharp photo or PDF · whole invoice in frame",
    scan_analyzing: "Analyzing with AI",
    scan_analyzing_step: "Reading items, quantities and prices…",
    scan_recognized: "items recognized",
    scan_check_all: "Select all",
    scan_review_p: "Review quantities and prices, then confirm. Edit or remove any line.",
    scan_onhand: "on hand",
    scan_price_up: "Price change",
    scan_update_price: "Update price",
    scan_new_sku: "New",
    scan_remembered: "remembered",
    scan_ai: "AI",
    scan_by_pack: "by",
    scan_pack: "pack",
    scan_new_details: "New item details",
    scan_map_to: "Map to",
    scan_create: "Create",
    scan_pack_label: "Pack / size",
    scan_pack_label_ph: "e.g. 28 oz bag",
    scan_pack_qty: "Base qty per pack",
    scan_pack_needed: "Enter the base quantity for this size.",
    scan_grouped: "Same item",
    scan_grouped_hint: "multiple sizes → one item with packs",
    scan_split: "Split",
    scan_import: "Import to inventory",
    scan_succ_h: "Inventory updated!",
    scan_succ_one: "item imported",
    scan_succ_many: "items imported",
    scan_error: "Couldn't read the invoice. Try again.",
    scan_retry: "Try again",
    scan_leave_title: "Leave without saving?",
    scan_leave_body: "Your invoice edits haven't been imported and will be lost.",
    scan_leave_stay: "Keep editing",
    scan_leave_discard: "Discard changes",
    home_refresh: "Refresh",

    done: "Done",
    f_name: "Name",
    f_price: "Unit price",
    f_category: "Category",
    f_unit: "Unit",
    f_unit_kind: "Unit type",
    unit_kind_count: "Count",
    unit_kind_weight: "Weight",
    unit_kind_volume: "Volume",
    f_par: "Min par",
    f_par_max: "Max par",
    f_par_max_hint: "Max par must be ≥ min par.",
    f_vendor: "Vendor",
    f_optional: "optional",

    items_sub: "Tap an item to edit or adjust.",
    items_search_ph: "Search item or SKU…",
    items_code_lookup: "Look up by code",
    items_code_not_found: "Barcode not found",
    items_scan_camera: "Scan with camera",
    scan_cam_title: "Scan the barcode",
    scan_cam_hint: "Point the camera at the barcode",
    scan_cam_denied: "Allow camera access to scan",
    scan_cam_nocam: "No camera available",
    scan_cam_error: "Couldn't open the camera",
    scan_cam_type_instead: "Type the code",
    pack_by_unit: "By unit",
    pack_count_unit: "packs",
    items_all: "All",
    items_none: "No results",
    items_new: "New item",
    it_edit: "Edit",
    it_save: "Save",
    it_apply: "Apply",
    it_in_stock: "On hand",
    it_status_critical: "Critical",
    it_status_low: "Low",
    it_status_ok: "Healthy",
    it_act_86: "Mark 86",
    it_act_un86: "Un-86",
    it_recount_set: "Actual count",
    it_waste_sub: "Subtract",
    it_act_receive: "Receive",
    it_receive_sub: "How much arrived?",
    it_create: "Create item",
    add_title: "Add item",
    add_scan: "Scan barcode",
    add_scan_sub: "Snap a package, we'll pre-fill it",
    add_manual: "Enter manually",
    add_manual_sub: "Type the details yourself",

    rcv_title: "Receive",
    rcv_sub: "Orders in transit",
    rcv_intransit: "in transit",
    rcv_expected: "Expected",
    rcv_checkall: "All OK",
    rcv_ok: "OK",
    rcv_short: "Short",
    rcv_received: "Received",
    rcv_finish: "Confirm receiving",
    rcv_done: "Receiving recorded!",
    rcv_updated: "Inventory updated",
    rcv_none: "No open orders",

    wst_title: "Waste",
    wst_pick: "What was wasted?",
    wst_qty: "Quantity",
    wst_register: "Log waste",
    wst_done: "Waste recorded!",

    rco_title: "Recount",
    rco_sub: "Count and adjust real stock",
    rco_system: "System",
    rco_save: "Save count",
    rco_done: "Count saved!",
    rco_count: "counted",

    edititem_icon: "Icon",
    edititem_icon_change: "Tap to change the icon",
    icon_picker_title: "Choose an icon",
    icon_picker_clear: "Use default icon",
    icon_grp_drinks: "Drinks",
    icon_grp_dairy: "Dairy & ice cream",
    icon_grp_fruit: "Fruit",
    icon_grp_veg: "Vegetables",
    icon_grp_food: "Food",
    icon_grp_bakery: "Bakery & bread",
    icon_grp_toppings: "Toppings & candy",
    icon_grp_packaging: "Packaging",
    icon_grp_supplies: "Supplies",
    icon_grp_symbols: "Symbols",
    it_delete: "Delete item",
    it_delete_q: "Delete this item?",
    it_delete_note:
      "It'll be hidden from active inventory. History is kept and a manager can restore it.",
    it_delete_yes: "Yes, delete",

    undo: "Undo",
    it_select: "Select",
    it_select_all: "Select all",
    it_deselect_all: "Deselect all",
    it_sel_title: "Select items",
    it_sel_tap: "Tap items to select.",
    it_sel_n: "{n} selected",
    it_sel_more: "Tap more to add, or use the bar below.",
    it_del_n: "Delete {n}",
    it_del_confirm_one: "Delete 1 item?",
    it_del_confirm_many: "Delete {n} items?",
    it_del_confirm_btn_one: "Delete 1 item",
    it_del_confirm_btn_many: "Delete {n} items",
    it_del_note:
      "This archives the selected items from the active list. A manager can restore them later from Backoffice.",
    it_deleted_one: "1 item deleted",
    it_deleted_many: "{n} items deleted",

    it_empty_results_s: "No items match “{q}”",
    it_empty_clear: "Clear search",
    it_empty_filter_t: "Nothing here",
    it_empty_filter_s: "No items match this filter.",
    it_empty_show_all: "Show all",
    it_empty_none: "No items yet.",

    flow_undone: "Change undone",

    net_online: "Online",
    net_offline: "Offline",
    net_offline_banner: "Offline — you can keep browsing. Saving needs a connection.",
    net_back_online: "Back online",

    scan_pull_tile: "Scan barcode",
    scan_pull_tile_sub: "Subtract what you pulled",
    scan_found: "Item found",
    scan_adjust_hint: "− for what you took · + for what you received",
    scan_sub_btn: "Subtract",
    scan_add_btn: "Add",
    scan_apply_zero: "Set a quantity",
    scan_pull_done: "Stock updated",
    scan_add_q: "This barcode isn't registered. Add it as a new item?",
    scan_add_cta: "Add item",
    scan_add_dismiss: "Keep scanning",

    sr_btn: "Scan",
    sr_title: "Scan to add",
    sr_scan_cta: "Scan a barcode",
    sr_manual: "Or enter the code",
    sr_lookup: "Look up",
    sr_searching: "Searching…",
    sr_already: "Already registered",
    sr_scan_next: "Scan another",
    sr_found: "found — review",
    sr_new: "new — fill in the details",
    sr_name: "Name",
    sr_category: "Category",
    sr_unit: "Unit",
    sr_pack: "Pack (optional)",
    sr_pack_qty: "Units / pack",
    sr_register: "Register",
    sr_saving: "Saving…",
    sr_saved: "Registered!",
    sr_error: "Could not save. Try again.",
    sr_recv_q: "How many did you receive?",
    sr_recv: "Receive",
    sr_skip: "Skip",
    sr_in: "In",
    sr_recv_later: "Receive later",
  },
};
