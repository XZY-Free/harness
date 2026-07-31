import "@/app/globals.css";
import { createRoot } from "react-dom/client";
import { DesktopRendererApp } from "./desktop-renderer-app";

const root = document.getElementById("root");
if (!root) throw new Error("Desktop renderer 缺少 #root 节点");

createRoot(root).render(<DesktopRendererApp />);
