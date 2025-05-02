terminalAPI.sendCommand();

const terminal = document.getElementById('terminal');
terminalAPI.onIncomingData((data) => {
    console.log(data)
    const pre = document.createElement('pre');
    pre.textContent = data;
    terminal.appendChild(pre);
    terminal.scrollTop = terminal.scrollHeight;
}
);
terminalAPI.onClose(() => {
    const pre = document.createElement('pre');
    pre.textContent = 'Terminal closed';
    terminal.appendChild(pre);
    terminal.scrollTop = terminal.scrollHeight;
}
);