// windows only test
import index from "./index.js"
import * as java from "./java.js"
import { describe, it, expect } from "vitest"
import fs from "fs/promises"

describe("API exists", () => {
    it("Should be defined", () => {
        expect(index).toBeDefined()
    })
})

describe("API methods", () => {
    it("Can get OS name", () => {
        expect(index.getOSName()).toBeDefined()
        expect(index.getOSName()).eq("windows")
    })
    it("Can check rules", () => {
        expect(index.checkRule({
            "action": "allow",
            "os": {
                "name": "osx"
            }
        })).eq(false)
        expect(index.checkRule({
            "action": "allow",
            "os": {
                "name": "linux"
            }
        })).eq(false)
        expect(index.checkRule({
            "action": "allow",
            "os": {
                "name": "windows"
            }
        })).eq(true)
    })
})

describe("Java API", () => {
    it("Should be defined", () => {
        expect(java.downloadJava).toBeDefined()
        expect(java.downloadJava).toBeTypeOf("function")
    })
})

describe("Can handle manifest", () => {
    it("Should be defined", async () => {
        expect(await index.loadManifest("neoforge-21.1.162.json")).toBeDefined()
    })
    it("Should merge Manifests", async () => {
        expect(await index.mergeManifests(await index.loadManifest("neoforge-21.1.162.json"), await index.loadManifest("1.21.1.json"))).toBeDefined()
        expect(await index.mergeManifests(await index.loadManifest("neoforge-21.1.162.json"), await index.loadManifest("1.21.1.json"))).toBeTypeOf("object")
    })
})

describe("Misc functions", () => {
    it("Should be defined", async () => {
        expect(index.downloadFile).toBeDefined()
        await fs.rm("test.txt", { force: true })
        const download = await index.downloadFile("https://example.com", "test.txt")
        expect(download).toBeDefined()
        expect(download).toBeTypeOf("boolean")
        expect(download).eq(true)
    })
})