// Compatibility surface for the row operations that used to share this file.
export {
  encodePrimaryKey,
  encodeRowPrimaryKey,
  keyFromRow,
} from "./keys";
export { normalizeRowOperation } from "./normalization";
export {
  applyRowOperation,
  readTableRow,
  readTableRows,
} from "./state";
