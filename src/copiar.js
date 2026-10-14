// Copia para a área de transferência. Com `alternativa`, usa o execCommand quando o
// navegador não deixa usar a API nova (ex.: arquivo aberto direto do disco).
export function copiarTexto(texto, ok, alternativa = false) {
  const alt = () => {
    if (!alternativa) return;
    const a = document.createElement("textarea");
    a.value = texto;
    document.body.appendChild(a);
    a.select();
    try {
      document.execCommand("copy");
      ok();
    } catch (e) { /* sem cópia */ }
    a.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(ok, alt);
  else alt();
}
