/**
 * vcard.js
 * Minimal, dependency-free vCard 3.0/4.0 parser sufficient for populating
 * the Contact form. Not a full spec implementation, but handles the common
 * fields: FN/N, TEL, EMAIL, and X- social fields when present.
 */

const VCardParser = (() => {
  function unfold(text) {
    // vCard folds long lines with a leading space/tab on the continuation.
    return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  }

  function splitCards(text) {
    const unfolded = unfold(text);
    const cards = [];
    const re = /BEGIN:VCARD([\s\S]*?)END:VCARD/gi;
    let m;
    while ((m = re.exec(unfolded)) !== null) {
      cards.push(m[1]);
    }
    return cards;
  }

  function parseLine(line) {
    const idx = line.indexOf(':');
    if (idx === -1) return null;
    const rawKey = line.slice(0, idx);
    const rawValue = line.slice(idx + 1).trim();
    const [key, ...params] = rawKey.split(';');
    return { key: key.toUpperCase(), params, value: rawValue };
  }

  function decodeValue(value) {
    return value
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\');
  }

  const PLATFORM_MAP = {
    CELL: 'phone', HOME: 'phone', WORK: 'phone', VOICE: 'phone',
    WHATSAPP: 'whatsapp', DISCORD: 'discord', INSTAGRAM: 'instagram', SNAPCHAT: 'snapchat',
  };

  function parseCard(cardText) {
    const lines = cardText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const contact = {
      fullName: '',
      contactMethods: [],
      tags: [],
      notes: '',
    };

    for (const rawLine of lines) {
      const parsed = parseLine(rawLine);
      if (!parsed) continue;
      const { key, params, value } = parsed;
      const val = decodeValue(value);

      switch (key) {
        case 'FN':
          contact.fullName = val;
          break;
        case 'N':
          if (!contact.fullName) {
            const parts = val.split(';').filter(Boolean);
            contact.fullName = parts.reverse().join(' ').trim();
          }
          break;
        case 'TEL': {
          const typeParam = params.find((p) => p.toUpperCase().startsWith('TYPE'));
          const type = typeParam ? typeParam.split('=')[1]?.toUpperCase() : 'CELL';
          contact.contactMethods.push({ platform: 'phone', value: val });
          break;
        }
        case 'EMAIL':
          contact.contactMethods.push({ platform: 'email', value: val });
          break;
        case 'NOTE':
          contact.notes = (contact.notes ? contact.notes + '\n' : '') + val;
          break;
        case 'ORG': {
          const orgParts = val.split(';');
          contact.company = orgParts[0];
          if (orgParts[1]) contact.department = orgParts[1];
          break;
        }
        case 'TITLE':
          contact.jobTitle = val;
          break;
        case 'NICKNAME':
          contact.nickname = val.split(',')[0];
          break;
        case 'BDAY': {
          // vCard dates are usually YYYYMMDD or YYYY-MM-DD; normalize to YYYY-MM-DD for the <input type="date"> field.
          const digits = val.replace(/[^0-9]/g, '');
          if (digits.length === 8) contact.birthday = `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6,8)}`;
          else if (/^\d{4}-\d{2}-\d{2}$/.test(val)) contact.birthday = val;
          break;
        }
        case 'URL':
          if (!contact.website) contact.website = val;
          break;
        case 'ADR': {
          // ADR;TYPE=...:pobox;ext;street;city;region;postalCode;country
          const p = val.split(';');
          const street = [p[2], p[1]].filter(Boolean).join(' ').trim();
          const address = { street, city: p[3] || '', region: p[4] || '', postalCode: p[5] || '', country: p[6] || '' };
          if (street || address.city || address.region || address.postalCode || address.country) contact.address = address;
          break;
        }
        case 'X-SOCIALPROFILE': {
          const typeParam = params.find((p) => p.toUpperCase().startsWith('TYPE'));
          const type = typeParam ? typeParam.split('=')[1]?.toUpperCase() : 'OTHER';
          const platform = PLATFORM_MAP[type] || 'other';
          contact.contactMethods.push({ platform, value: val });
          break;
        }
        default:
          break;
      }
    }

    if (!contact.fullName) contact.fullName = 'Unnamed contact';
    return contact;
  }

  function parse(text) {
    return splitCards(text).map(parseCard);
  }

  return { parse };
})();
