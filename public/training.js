(() => {
  const $ = id => document.getElementById(id);
  const node = (tag, text) => { const element = document.createElement(tag); element.textContent = text; return element; };
  function validate(data) {
    if (data?.kind !== 'curated_synthetic_training_examples' || !Array.isArray(data.cases) || !data.cases.length || !Array.isArray(data.sources) || typeof data.notice !== 'string' || typeof data.referencePurpose !== 'string') throw Error('Invalid training collection.');
    const sources = new Map(data.sources.map(source => [source.id, source]));
    if (sources.size !== data.sources.length || data.sources.some(source => typeof source.id !== 'string' || typeof source.title !== 'string' || typeof source.url !== 'string' || !/^https:\/\/support\.workflowmax\.com\/hc\/en-us\/articles\/[\w-]+$/.test(source.url))) throw Error('Invalid learning reference.');
    const ids = new Set();
    for (const example of data.cases) {
      if (!example || ids.has(example.id) || ['id','title','customer','subject','email','outcome','expectedResponse','explanation'].some(key => typeof example[key] !== 'string' || !example[key].trim()) || ['flow','reviewerChecks','sourceIds'].some(key => !Array.isArray(example[key]) || example[key].some(value => typeof value !== 'string')) || example.sourceIds.some(id => !sources.has(id))) throw Error('Invalid training example.');
      ids.add(example.id);
    }
    return sources;
  }
  async function load() {
    try {
      const response = await fetch('/training-cases.json', { cache: 'no-store' });
      if (!response.ok) throw Error('Training collection unavailable.');
      const data = await response.json(), sources = validate(data);
      $('trainingNotice').textContent = data.notice;
      $('trainingReferenceNotice').textContent = data.referencePurpose;
      $('trainingCount').textContent = `${data.cases.length} fictional examples`;
      let selected = data.cases[0].id;
      function show(example, focus = false) {
        selected = example.id;
        $('trainingCustomer').textContent = `${example.customer} · fictional customer`;
        for (const [id, field] of [['trainingTitle','title'],['trainingSubject','subject'],['trainingEmail','email'],['trainingOutcome','outcome'],['trainingResponse','expectedResponse'],['trainingExplanation','explanation']]) $(id).textContent = example[field];
        $('trainingFlow').replaceChildren(...example.flow.map(text => node('li', text)));
        $('trainingChecks').replaceChildren(...example.reviewerChecks.map(text => node('li', text)));
        $('trainingSources').replaceChildren(...example.sourceIds.map(id => {
          const source = sources.get(id), card = node('article', ''), link = node('a', source.title);
          link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
          card.append(link, node('p', `${id} · official support article`)); return card;
        }));
        if (!example.sourceIds.length) $('trainingSources').append(node('p', 'No article is used to support a product answer in this example. Read the handling boundary and reviewer checks.'));
        $('trainingList').replaceChildren(...data.cases.map(item => {
          const button = node('button', ''); button.className = 'sample-item'; button.setAttribute('aria-current', String(item.id === selected));
          button.append(node('strong', `${item.customer} · ${item.title}`), node('span', item.outcome));
          button.addEventListener('click', () => show(item, true)); return button;
        }));
        if (focus) $('trainingTitle').focus?.();
      }
      show(data.cases[0]); $('trainingContent').hidden = false;
    } catch {
      $('trainingNotice').textContent = 'The training examples could not be loaded. No model request was made.';
      $('trainingError').textContent = 'Refresh this page to try again. No saved conversations have been changed.';
      $('trainingError').hidden = false; $('trainingContent').hidden = true;
    }
  }
  if (['localhost', '127.0.0.1'].includes(location.hostname)) { $('trainingLiveLink').href = '/practice'; $('trainingLiveLink').textContent = 'Local practice workspace'; }
  load();
})();
