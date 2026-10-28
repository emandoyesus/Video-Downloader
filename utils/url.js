export function isValidHttpUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

export function extractFirstUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/gi;
  const match = text.match(urlRegex);
  if (match && match.length > 0) {
    let url = match[0];
    url = url.replace(/[),.!?;:'"]+$/, '');
    return url;
  }
  return null;
}
