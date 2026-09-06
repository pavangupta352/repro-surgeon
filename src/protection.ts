const LEGAL_NAME = /^(?:(?:licen[cs]es?|notices?|copying|copyright)(?:[._-].*)?|(?:third[._-]?party|3rd[._-]?party)[._-](?:licen[cs]es?|notices?)(?:[._-].*)?)$/i;

/** Legal directories and conventional notice filenames are retained conservatively. */
export function isLegalPath(filePath: string): boolean {
  return filePath.split('/').some(part => LEGAL_NAME.test(part));
}
