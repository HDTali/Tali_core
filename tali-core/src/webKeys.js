// Turning THD wording into simple keys the website's texts (and the PDF
// reading library) use. Shared by routes/web.js and webReading.js.

function typeKey(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('manifesting')) return 'manifesting_generator';
  if (t.includes('generator')) return 'generator';
  if (t.includes('manifestor')) return 'manifestor';
  if (t.includes('projector')) return 'projector';
  if (t.includes('reflector')) return 'reflector';
  return null;
}

function authorityKey(authority) {
  const a = String(authority || '').toLowerCase();
  if (a.includes('emotion') || a.includes('solar')) return 'emotional';
  if (a.includes('sacral')) return 'sacral';
  if (a.includes('splen')) return 'splenic';
  if (a.includes('self')) return 'self_projected';
  if (a.includes('ego') || a.includes('heart')) return 'ego';
  if (a.includes('lunar') || a.includes('moon')) return 'lunar';
  if (a.includes('mental') || a.includes('environment') || a.includes('sounding') || a.includes('none'))
    return 'mental';
  return null;
}

function profileKey(profile) {
  const m = /(\d)\s*\/\s*(\d)/.exec(String(profile || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

module.exports = { typeKey, authorityKey, profileKey };
