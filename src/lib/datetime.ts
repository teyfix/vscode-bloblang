export const isoDate = () =>
  new Date().toISOString().split('T').slice(0, 1).join('');
