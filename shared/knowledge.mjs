const stop = new Set('a an the how where what do does i my we our you your can could would should is are was be to for of on in and with at it this that have has please help need want before from into'.split(' '));
const aliases = { jobs: 'job', project: 'job', customer: 'client', hours: 'time', hour: 'time', timesheets: 'timesheet', recording: 'record', entering: 'entry', enter: 'entry', entries: 'entry', automatically: 'autosave', itself: 'autosave', manually: 'manual', saving: 'save', saved: 'save', started: 'start', starting: 'start', creation: 'create', creating: 'create', permissions: 'permission' };
export function words(text) {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(word => !stop.has(word)).map(word => aliases[word] || word))];
}

export function retrieve(input, corpus) {
  const query = words(`${input.subject} ${input.body}`);
  const ranked = corpus.articles.filter(article => article.active).map(article => {
    const tags = new Set(words(article.tags.join(' ')));
    const title = new Set(words(article.title));
    const text = new Set(words(`${article.summary} ${article.facts.join(' ')}`));
    const score = query.reduce((sum, word) => sum + (tags.has(word) ? 4 : 0) + (title.has(word) ? 2 : 0) + (text.has(word) ? 1 : 0), 0);
    return { ...article, score };
  }).filter(article => article.score >= 5).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const threshold = Math.max(5, (ranked[0]?.score || 0) * 0.5);
  return ranked.filter(article => article.score >= threshold).slice(0, 2);
}

export function relevantFacts(input, source) {
  const query = new Set(words(`${input.subject} ${input.body}`));
  return source.facts.map((fact, index) => ({ fact, index, score: words(fact).filter(word => query.has(word)).length }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 2).map(item => item.fact);
}
