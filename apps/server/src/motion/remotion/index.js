// Punto de entrada del bundle de Remotion (JS plano: lo empaqueta webpack, no pasa por tsc).
import { registerRoot } from "remotion";
import { Root } from "./Root.js";

registerRoot(Root);
