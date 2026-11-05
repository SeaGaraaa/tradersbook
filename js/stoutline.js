// Стратегия текстом (Markdown) → дерево разделов по заголовкам #, ##, ### и обратно.
// Нужна для «Порядка разделов»: раздел переносится целиком — с текстом и подразделами.
// Заголовки внутри ``` и блоков ::: не считаются разделами.

const HEAD = /^(#{1,3})\s+(.*)$/;

export function parse(md) {
  const lines = md.split("\n");
  const root = { level: 0, head: null, title: "", body: [], children: [] };
  const stack = [root];
  let fence = false, block = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("```")) fence = !fence;
    else if (!fence && t.startsWith(":::")) block += t === ":::" ? (block ? -1 : 0) : 1;
    const m = !fence && !block && !t.startsWith("```") ? line.match(HEAD) : null;
    if (m) {
      const n = { level: m[1].length, head: line, title: m[2].trim(), body: [], children: [] };
      while (stack.at(-1).level >= n.level) stack.pop();
      stack.at(-1).children.push(n);
      stack.push(n);
    } else stack.at(-1).body.push(line);
  }
  return root;
}

// Склеивает дерево обратно. Без перестановок даёт исходный текст.
export function serialize(root) {
  const out = [];
  const walk = (n) => {
    if (n.head != null) out.push(n.head);
    out.push(...n.body);
    n.children.forEach(walk);
  };
  walk(root);
  return out.join("\n");
}

// После перестановки: у каждого раздела, за которым что-то идёт, в конце пустая строка —
// иначе последний раздел, переехавший в середину, слипнется со следующим заголовком.
export function tidy(root) {
  const nodes = [];
  const walk = (n) => { nodes.push(n); n.children.forEach(walk); };
  walk(root);
  nodes.forEach((n, i) => {
    if (i === nodes.length - 1) return;
    if (n.children.length) return; // текст перед подразделом
    const b = n.body;
    while (b.length && !b.at(-1).trim()) b.pop();
    b.push("");
  });
  // текст раздела перед его первым подразделом
  nodes.forEach((n) => {
    if (!n.children.length || (n.head == null && !n.body.length)) return;
    const b = n.body;
    while (b.length && !b.at(-1).trim()) b.pop();
    b.push("");
  });
  // в самом конце — без пустых строк, как обычно
  const last = nodes.at(-1);
  while (last.body.length && !last.body.at(-1).trim()) last.body.pop();
  return root;
}

// Узел по пути «3.0.2» (индексы детей от корня).
export function nodeAt(root, path) {
  return path === "" ? root : path.split(".").reduce((n, i) => n.children[+i], root);
}

// Сколько строк текста в разделе вместе с подразделами (без пустых).
export function size(n) {
  return n.body.filter((x) => x.trim()).length + n.children.reduce((s, c) => s + 1 + size(c), 0);
}
