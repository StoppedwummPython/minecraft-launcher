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
            <button class="install" onclick="installMod('${project.slug}')">Install</button>
        `
        resultDiv.appendChild(projectDiv)
    }
});