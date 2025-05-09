const mods = await window.mcAPI.getModFiles()
document.getElementById("search").addEventListener("click", async function() {
    let search = document.getElementById("searchText").value;
    let searchUrl = "https://mc-backend-six.vercel.app/api/search?q=" + encodeURIComponent(search)
    const searchResult = await fetch(searchUrl)
    const data = await searchResult.json()
    let result = data.hits
    let resultDiv = document.getElementById("result")
    resultDiv.innerHTML = ""
    for (var i = 0; i < result.length; i++) {
        let project = result[i]
        let projectDiv = document.createElement("div")
        projectDiv.className = "project"
        projectDiv.innerHTML = `
            <img src="${project.icon_url}" alt="${project.title}">
            <h3>${project.title}</h3>
            <p>${project.description}</p>
            <p>Downloads: ${project.downloads}</p>
            <p>Follows: ${project.follows}</p>
            <a href="https://modrinth.com/${project.project_type}/${project.slug}" target="_blank">View on Modrinth</a>
            <button class="install btn btn-primary" onclick="installMod('${project.slug}')" ${mods.find(mod => new String(mod.metadata[0].id).includes(project.slug)) ? "disabled=1" : ""} id="${project.slug}">${mods.find(mod => mod.metadata[0].id == project.slug) ? "Installed" : "Install"}</button>
        `
        resultDiv.appendChild(projectDiv)
    }
});

const modsDiv = document.getElementById("installedMods")
for (var i = 0; i < mods.length; i++) {
    let mod = mods[i]
    console.log(mod)
    let modDiv = document.createElement("div")
    modDiv.className = "mod"
    modDiv.innerHTML = `
        <h3>${mod.metadata[0].name}</h3>
        <p>${mod.metadata[0].description}</p>
        <p>Version: ${mod.metadata[0].version}</p>
        <p>Path: ${mod.path}</p>
        <button class="uninstall btn btn-primary" onclick="uninstallMod('${mod.path}')"} id="${mod.path}">Uninstall</button>
    `
    modsDiv.appendChild(modDiv)
}
