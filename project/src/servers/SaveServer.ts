import { inject, injectAll, injectable } from "tsyringe";

import { SaveLoadRouter } from "@spt-aki/di/Router";
import { IAkiProfile, Info } from "@spt-aki/models/eft/profile/IAkiProfile";
import { ConfigTypes } from "@spt-aki/models/enums/ConfigTypes";
import { ICoreConfig } from "@spt-aki/models/spt/config/ICoreConfig";
import { ILogger } from "@spt-aki/models/spt/utils/ILogger";
import { LocalisationService } from "@spt-aki/services/LocalisationService";
import { HashUtil } from "@spt-aki/utils/HashUtil";
import { JsonUtil } from "@spt-aki/utils/JsonUtil";
import { VFS } from "@spt-aki/utils/VFS";
import { ConfigServer } from "./ConfigServer";

@injectable()
export class SaveServer
{
    protected profileFilepath = "user/profiles/";
    protected profiles = {};
    // onLoad = require("../bindings/SaveLoad");
    protected onBeforeSaveCallbacks = {};
    protected saveMd5 = {};

    constructor(
        @inject("VFS") protected vfs: VFS,
        @injectAll("SaveLoadRouter") protected saveLoadRouters: SaveLoadRouter[],
        @inject("JsonUtil") protected jsonUtil: JsonUtil,
        @inject("HashUtil") protected hashUtil: HashUtil,
        @inject("LocalisationService") protected localisationService: LocalisationService,
        @inject("WinstonLogger") protected logger: ILogger,
        @inject("ConfigServer") protected configServer: ConfigServer,
    )
    {}

    /**
     * Add callback to occur prior to saving profile changes
     * @param id Id for save callback
     * @param callback Callback to execute prior to running SaveServer.saveProfile()
     */
    public addBeforeSaveCallback(id: string, callback: (profile: Partial<IAkiProfile>) => Partial<IAkiProfile>): void
    {
        this.onBeforeSaveCallbacks[id] = callback;
    }

    /**
     * Remove a callback from being executed prior to saving profile in SaveServer.saveProfile()
     * @param id Id of callback to remove
     */
    public removeBeforeSaveCallback(id: string): void
    {
        this.onBeforeSaveCallbacks[id] = null;
    }

    /**
     * Load all profiles in /user/profiles folder into memory (this.profiles)
     */
    public load(): void
    {
        // get files to load
        if (!this.vfs.exists(this.profileFilepath))
        {
            this.vfs.createDir(this.profileFilepath);
        }

        const files = this.vfs.getFiles(this.profileFilepath).filter((item) =>
        {
            return this.vfs.getFileExtension(item) === "json";
        });

        // load profiles
        for (const file of files)
        {
            this.loadProfile(this.vfs.stripExtension(file));
        }
    }

    /**
     * Save changes for each profile from memory into user/profiles json
     */
    public save(): void
    {
        // Save every profile
        let totalTime = 0;
        for (const sessionID in this.profiles)
        {
            totalTime += this.saveProfile(sessionID);
        }

        this.logger.debug(
            `Saved ${Object.keys(this.profiles).length} profiles, took: ${totalTime.toFixed(2)}ms`,
            false,
        );
    }

    /**
     * Get a player profile from memory
     * @param sessionId Session id
     * @returns IAkiProfile
     */
    public getProfile(sessionId: string): IAkiProfile
    {
        if (!sessionId)
        {
            throw new Error("session id provided was empty, did you restart the server while the game was running?");
        }

        if (this.profiles === null)
        {
            throw new Error(`no profiles found in saveServer with id: ${sessionId}`);
        }

        if (this.profiles[sessionId] === null)
        {
            throw new Error(`no profile found for sessionId: ${sessionId}`);
        }

        return this.profiles[sessionId];
    }

    /**
     * Get all profiles from memory
     * @returns Dictionary of IAkiProfile
     */
    public getProfiles(): Record<string, IAkiProfile>
    {
        return this.profiles;
    }

    /**
     * Delete a profile by id
     * @param sessionID Id of profile to remove
     * @returns true when deleted, false when profile not found
     */
    public deleteProfileById(sessionID: string): boolean
    {
        if (this.profiles[sessionID] != null)
        {
            delete this.profiles[sessionID];
            return true;
        }

        return false;
    }

    /**
     * Create a new profile in memory with empty pmc/scav objects
     * @param profileInfo Basic profile data
     */
    public createProfile(profileInfo: Info): void
    {
        if (this.profiles[profileInfo.id] != null)
        {
            throw new Error(`profile already exists for sessionId: ${profileInfo.id}`);
        }

        this.profiles[profileInfo.id] = { info: profileInfo, characters: { pmc: {}, scav: {} } };
    }

    /**
     * Add full profile in memory by key (info.id)
     * @param profileDetails Profile to save
     */
    public addProfile(profileDetails: IAkiProfile): void
    {
        this.profiles[profileDetails.info.id] = profileDetails;
    }

    /**
     * Look up profile json in user/profiles by id and store in memory
     * Execute saveLoadRouters callbacks after being loaded into memory
     * @param sessionID Id of profile to store in memory
     */
    public loadProfile(sessionID: string): void
    {
        const filename = `${sessionID}.json`;
        const filePath = `${this.profileFilepath}${filename}`;
        if (this.vfs.exists(filePath))
        {
            // File found, store in profiles[]
            const start = performance.now();
            this.profiles[sessionID] = this.jsonUtil.deserialize(this.vfs.readFile(filePath), filename);
            this.logger.debug(`Profile: ${sessionID} took: ${performance.now() - start}ms to load.`, true);
        }

        // Run callbacks
        for (const callback of this.saveLoadRouters)
        {
            this.profiles[sessionID] = callback.handleLoad(this.getProfile(sessionID));
        }
    }

    /**
     * Save changes from in-memory profile to user/profiles json
     * Execute onBeforeSaveCallbacks callbacks prior to being saved to json
     * @param sessionID profile id (user/profiles/id.json)
     * @returns time taken to save in MS
     */
    public saveProfile(sessionID: string): number
    {
        const filePath = `${this.profileFilepath}${sessionID}.json`;

        // Run pre-save callbacks before we save into json
        for (const callback in this.onBeforeSaveCallbacks)
        {
            const previous = this.profiles[sessionID];
            try
            {
                this.profiles[sessionID] = this.onBeforeSaveCallbacks[callback](this.profiles[sessionID]);
            }
            catch (error)
            {
                this.logger.error(this.localisationService.getText("profile_save_callback_error", { callback, error }));
                this.profiles[sessionID] = previous;
            }
        }

        const start = performance.now();
        const jsonProfile = this.jsonUtil.serialize(
            this.profiles[sessionID],
            !this.configServer.getConfig<ICoreConfig>(ConfigTypes.CORE).features.compressProfile,
        );
        const fmd5 = this.hashUtil.generateMd5ForData(jsonProfile);
        if (typeof (this.saveMd5[sessionID]) !== "string" || this.saveMd5[sessionID] !== fmd5)
        {
            this.saveMd5[sessionID] = String(fmd5);
            // save profile to disk
            this.vfs.writeFile(filePath, jsonProfile);
        }

        return Number(performance.now() - start);
    }

    /**
     * Remove a physical profile json from user/profiles
     * @param sessionID Profile id to remove
     * @returns true if file no longer exists
     */
    public removeProfile(sessionID: string): boolean
    {
        const file = `${this.profileFilepath}${sessionID}.json`;

        delete this.profiles[sessionID];

        this.vfs.removeFile(file);

        return !this.vfs.exists(file);
    }
}
