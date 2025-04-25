import {v4 as genuuid} from "uuid"
import { createInterface } from "readline";
import fs from "fs/promises"

// function to get input from the user
function getInput(prompt) {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => {
        rl.question(prompt, answer => {
            rl.close();
            resolve(answer);
        });
    });
}

const username = await getInput("Enter your username: ");
const uuidinput = await getInput("Enter your UUID (or just press enter to generate a new one): ");
const uuid = uuidinput !== "" ? uuidinput : genuuid();
const config = {
    "auth_player_name": username,
    "auth_uuid": uuid
};


console.log("Your UUID is:", uuid);
console.log("Don't share it with anyone!");
console.log("We recommend you to save it in a safe place.");

await fs.writeFile("./config.json", JSON.stringify(config));

