mcAPI.onMessage((msg) => {
    const c = document.getElementById('terminal');
    const newLine = document.createElement('pre');
    console.log(msg);
    newLine.innerText = msg;
    c.appendChild(newLine);
    c.scrollTop = c.scrollHeight;
});

mcAPI.onError((msg) => {
    const c = document.getElementById('terminal');
    const newLine = document.createElement('pre');
    console.error(msg);
    newLine.innerText = msg;
    newLine.className = 'error'
    c.appendChild(newLine);
    c.scrollTop = c.scrollHeight;
});