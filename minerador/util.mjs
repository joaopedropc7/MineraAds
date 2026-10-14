// Utilidades do minerador: banco SQLite, datas, esperas e concorrência.

import { DatabaseSync } from "node:sqlite";

const p2 = (n) => String(n).padStart(2, "0");

// "2026-10-13T12:00:00" em UTC.
export function strftimeUtc(d) {
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

// "2026-10-13 12:00:00" em UTC, o formato do datetime() do SQLite.
export function agora_sql() {
  return strftimeUtc(new Date()).replace("T", " ");
}

// "2026-10-13T12:00:00+00:00"
export function agora_iso() {
  return strftimeUtc(new Date()) + "+00:00";
}

// Corta por caractere (não quebra emoji ao meio).
export function corta(s, n) {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n).join("");
}

export const dormir = (seg) => new Promise((r) => setTimeout(r, seg * 1000));

// round() do Python: empate vai para o par (84.5 -> 84, 85.5 -> 86).
export function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// Roda `tarefa` em até `limite` itens ao mesmo tempo e entrega os resultados a `aoTerminar`
// na ordem da lista (como o ThreadPoolExecutor.map do Python).
export async function mapaLimitado(itens, limite, tarefa, aoTerminar) {
  const resultados = new Array(itens.length);
  const prontos = new Array(itens.length).fill(false);
  let proximo = 0, entregue = 0;
  const entregar = () => {
    while (entregue < itens.length && prontos[entregue]) {
      aoTerminar(resultados[entregue]);
      resultados[entregue] = undefined;
      entregue += 1;
    }
  };
  const trabalhador = async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      resultados[i] = await tarefa(itens[i]);
      prontos[i] = true;
      entregar();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, trabalhador));
  entregar();
}

// Mesmo comportamento do sqlite3 do Python: cada escrita abre uma transação,
// que só vale depois do commit().
export class Banco {
  constructor(caminho) {
    this.db = new DatabaseSync(caminho);
    this.emTransacao = false;
    this.cache = new Map();
  }

  prep(sql) {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.cache.set(sql, st);
    }
    return st;
  }

  static limpar(params) {
    return params.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v));
  }

  exec(sql) {
    this.commit();
    this.db.exec(sql);
  }

  run(sql, ...params) {
    if (!this.emTransacao) {
      this.db.exec("BEGIN");
      this.emTransacao = true;
    }
    return this.prep(sql).run(...Banco.limpar(params));
  }

  get(sql, ...params) {
    return this.prep(sql).get(...Banco.limpar(params));
  }

  all(sql, ...params) {
    return this.prep(sql).all(...Banco.limpar(params));
  }

  commit() {
    if (this.emTransacao) {
      this.db.exec("COMMIT");
      this.emTransacao = false;
    }
  }

  close() {
    this.commit();
    this.db.close();
  }
}
