const root = document.querySelector("#app");

if (!(root instanceof HTMLElement)) {
  throw new Error("The replacement app root is missing.");
}

const shell = document.createElement("main");
const title = document.createElement("h1");
const message = document.createElement("p");

title.textContent = "Infinite Quest Nexus";
message.textContent = "Slice 1 is not installed yet.";
shell.setAttribute("aria-label", "Replacement application preview");
shell.append(title, message);
root.replaceChildren(shell);
