/**
 * EMCP_WB_Layers.c - Layer management handler
 *
 * Actions: list, getActive, create, setActive, getEntityLayer, isVisible, getInfo, toggleLock
 * create (top-level layers only) and setActive use the documented sub-scene layer calls (CreateSubsceneLayer,
 * SetActiveSubsceneLayer); every response carries the active layer of the sub-scene.
 * The other actions identify layers by IDs from IEntitySource.GetLayerID().
 *
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_Layers"
 */

class EMCP_WB_LayersRequest : JsonApiStruct
{
	string action;
	int subScene;
	string entityName;
	bool visible;
	string layerPath;
	string name;
	string parentPath;

	void EMCP_WB_LayersRequest()
	{
		RegV("action");
		RegV("subScene");
		RegV("entityName");
		RegV("visible");
		RegV("layerPath");
		RegV("name");
		RegV("parentPath");
		subScene = -1;
	}
}

class EMCP_WB_LayersResponse : JsonApiStruct
{
	string status;
	string message;
	string action;
	int currentSubScene;
	int layerID;
	bool layerVisible;
	bool layerLocked;
	bool layerActive;
	int layerEntityCount;
	string activeLayer;
	string layerPath;

	// Layer data collected for list
	ref array<int> m_aLayerIDs;
	ref array<int> m_aEntityCounts;

	void EMCP_WB_LayersResponse()
	{
		RegV("status");
		RegV("message");
		RegV("action");
		RegV("currentSubScene");
		RegV("layerID");
		RegV("layerVisible");
		RegV("layerLocked");
		RegV("layerActive");
		RegV("layerEntityCount");
		RegV("activeLayer");
		RegV("layerPath");

		m_aLayerIDs = {};
		m_aEntityCounts = {};
	}

	override void OnPack()
	{
		if (m_aLayerIDs.Count() > 0)
		{
			StartArray("layers");
			for (int i = 0; i < m_aLayerIDs.Count(); i++)
			{
				StartObject("");
				StoreInteger("layerID", m_aLayerIDs[i]);
				StoreInteger("entityCount", m_aEntityCounts[i]);
				EndObject();
			}
			EndArray();
		}
	}
}

class EMCP_WB_Layers : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_LayersRequest();
	}

	//! The name becomes <World>_Layers\<name>.layer on save: letters, digits and '_' only (COALITION's layer names fit), 1 to 64 characters.
	static bool IsLayerName(string s)
	{
		if (s.Length() < 1 || s.Length() > 64)
			return false;
		for (int i = 0; i < s.Length(); i++)
		{
			int c = s.ToAscii(i);
			if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95))
				return false;
		}
		return true;
	}

	//! GetSubsceneLayerId returns an id >= 0 even for an unknown path (live 1.8), so check the sub-scene's own list.
	protected bool HasLayer(WorldEditorAPI api, int sub, string path)
	{
		array<string> layers = {};
		api.GetSubsceneFolders(sub, layers);
		return layers.Contains(path);
	}

	//! Layer and folder paths of a sub-scene, comma-separated, for "not found" messages.
	protected string LayerList(WorldEditorAPI api, int sub)
	{
		array<string> layers = {};
		api.GetSubsceneFolders(sub, layers);
		string list;
		foreach (string layer : layers)
		{
			if (list != "")
				list += ", ";
			list += layer;
		}
		return list;
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_LayersRequest req = EMCP_WB_LayersRequest.Cast(request);
		EMCP_WB_LayersResponse resp = new EMCP_WB_LayersResponse();
		resp.action = req.action;

		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
		{
			resp.status = "error";
			resp.message = "WorldEditor module not available";
			return resp;
		}

		WorldEditorAPI api = worldEditor.GetApi();
		if (!api)
		{
			resp.status = "error";
			resp.message = "WorldEditorAPI not available";
			return resp;
		}

		resp.currentSubScene = api.GetCurrentSubScene();
		int sub = req.subScene;
		if (sub < 0)
			sub = resp.currentSubScene;
		if (sub >= api.GetNumSubScenes())
		{
			resp.status = "error";
			resp.message = "subScene " + sub.ToString() + " does not exist (this world has " + api.GetNumSubScenes().ToString() + "; the edited one is " + resp.currentSubScene.ToString() + ")";
			return resp;
		}
		resp.activeLayer = api.GetActiveSubsceneLayer(sub);

		if (req.action == "list")
		{
			// Enumerate layers by scanning all entities and collecting unique layer IDs
			int entityCount = api.GetEditorEntityCount();
			map<int, int> layerCounts = new map<int, int>();

			for (int i = 0; i < entityCount; i++)
			{
				IEntitySource entSrc = api.GetEditorEntity(i);
				if (!entSrc)
					continue;

				int lid = entSrc.GetLayerID();
				if (layerCounts.Contains(lid))
				{
					int current = layerCounts.Get(lid);
					layerCounts.Set(lid, current + 1);
				}
				else
				{
					layerCounts.Set(lid, 1);
				}
			}

			// Output collected layers
			for (int k = 0; k < layerCounts.Count(); k++)
			{
				int layerKey = layerCounts.GetKey(k);
				int layerCount = layerCounts.GetElement(k);
				resp.m_aLayerIDs.Insert(layerKey);
				resp.m_aEntityCounts.Insert(layerCount);
			}

			resp.status = "ok";
			resp.message = "Found " + layerCounts.Count().ToString() + " layers across " + entityCount.ToString() + " entities";
		}
		else if (req.action == "getActive")
		{
			resp.status = "ok";
			resp.message = "Current sub-scene: " + resp.currentSubScene.ToString() + ", active layer: " + resp.activeLayer;
		}
		else if (req.action == "create")
		{
			resp.status = "error";
			if (!IsLayerName(req.name))
				resp.message = "name for create must be 1 to 64 letters, digits or '_' (it becomes the .layer file name): " + req.name;
			// Live 1.8: a layer created under another layer was not written by Save(), and its entities were lost
			else if (req.parentPath != "")
				resp.message = "Nested layers are not offered: a layer created under another layer through the script API is not saved (Save() returned false and its entities were lost, live check 2026-11-02). Create a top-level layer.";
			// A layer in a parent world would be saved into that world, which is usually packed or someone else's
			else if (sub != resp.currentSubScene)
				resp.message = "create works only in the sub-scene being edited (" + resp.currentSubScene.ToString() + "), not in " + sub.ToString();
			else if (HasLayer(api, sub, req.name))
				resp.message = "Layer already exists: " + req.name;
			else
			{
				resp.layerPath = api.CreateSubsceneLayer(sub, req.name, "");
				if (resp.layerPath == "")
				{
					resp.message = "CreateSubsceneLayer returned no path for " + req.name;
				}
				else
				{
					resp.status = "ok";
					resp.message = "Created layer " + resp.layerPath + " in sub-scene " + sub.ToString() + " (written on the next save)";
				}
			}
		}
		else if (req.action == "setActive")
		{
			resp.status = "error";
			if (req.layerPath == "")
			{
				resp.message = "layerPath parameter required for setActive";
			}
			// New entities go to the active layer of the edited sub-scene only
			else if (sub != resp.currentSubScene)
			{
				resp.message = "setActive works only in the sub-scene being edited (" + resp.currentSubScene.ToString() + "), not in " + sub.ToString();
			}
			else if (!HasLayer(api, sub, req.layerPath))
			{
				resp.message = "Layer not found: " + req.layerPath + ". Layers: " + LayerList(api, sub);
			}
			else
			{
				api.SetActiveSubsceneLayer(sub, req.layerPath);
				// SetActiveSubsceneLayer ignores a path it cannot use without an error: trust only the read-back
				resp.activeLayer = api.GetActiveSubsceneLayer(sub);
				resp.layerPath = req.layerPath;
				if (resp.activeLayer == req.layerPath)
				{
					resp.status = "ok";
					resp.message = "Active layer in sub-scene " + sub.ToString() + ": " + resp.activeLayer;
				}
				else
				{
					resp.message = "Active layer did not change to " + req.layerPath + ": it is " + resp.activeLayer;
				}
			}
		}
		else if (req.action == "getEntityLayer")
		{
			if (req.entityName == "")
			{
				resp.status = "error";
				resp.message = "entityName parameter required for getEntityLayer";
				return resp;
			}

			int count = api.GetEditorEntityCount();
			bool found = false;
			for (int i = 0; i < count; i++)
			{
				IEntitySource entSrc = api.GetEditorEntity(i);
				if (entSrc && entSrc.GetName() == req.entityName)
				{
					resp.layerID = entSrc.GetLayerID();
					found = true;
					break;
				}
			}

			if (found)
			{
				resp.status = "ok";
				resp.message = "Entity '" + req.entityName + "' is on layer " + resp.layerID.ToString();
			}
			else
			{
				resp.status = "error";
				resp.message = "Entity not found: " + req.entityName;
			}
		}
		else if (req.action == "isVisible")
		{
			if (req.layerPath == "")
			{
				resp.status = "error";
				resp.message = "layerPath parameter required for isVisible (use layer ID as string, e.g. '0')";
				return resp;
			}

			int targetLayerID = req.layerPath.ToInt();

			int subScene = resp.currentSubScene;
			resp.layerVisible = api.IsEntityLayerVisible(subScene, targetLayerID);
			resp.layerLocked = api.IsEntityLayerLocked(subScene, targetLayerID);
			resp.layerID = targetLayerID;
			resp.status = "ok";
			resp.message = "Layer " + req.layerPath + ": visible=" + resp.layerVisible.ToString() + " locked=" + resp.layerLocked.ToString();
		}
		else if (req.action == "getInfo")
		{
			if (req.layerPath == "")
			{
				resp.status = "error";
				resp.message = "layerPath parameter required for getInfo (use layer ID as string, e.g. '0')";
				return resp;
			}

			int targetLayerID = req.layerPath.ToInt();

			// Count entities on this layer
			int totalEntities = api.GetEditorEntityCount();
			int layerEntCount = 0;
			for (int i = 0; i < totalEntities; i++)
			{
				IEntitySource es = api.GetEditorEntity(i);
				if (es && es.GetLayerID() == targetLayerID)
					layerEntCount++;
			}

			int subScene2 = resp.currentSubScene;
			resp.layerID = targetLayerID;
			resp.layerEntityCount = layerEntCount;
			resp.layerVisible = api.IsEntityLayerVisible(subScene2, targetLayerID);
			resp.layerActive = (api.GetCurrentSubScene() == targetLayerID);
			resp.status = "ok";
			resp.message = "Layer " + req.layerPath + ": " + layerEntCount.ToString() + " entities";
		}
		else if (req.action == "toggleLock")
		{
			if (req.layerPath == "")
			{
				resp.status = "error";
				resp.message = "layerPath parameter required for toggleLock (use layer ID as string, e.g. '0')";
				return resp;
			}

			int targetLayerID = req.layerPath.ToInt();
			int subScene3 = resp.currentSubScene;
			bool isLocked = api.IsEntityLayerLocked(subScene3, targetLayerID);
			if (isLocked)
				api.UnlockEntityLayer(subScene3, targetLayerID);
			else
				api.LockEntityLayer(subScene3, targetLayerID);

			resp.layerLocked = !isLocked;
			resp.layerID = targetLayerID;
			resp.status = "ok";
			if (isLocked)
				resp.message = "Layer " + req.layerPath + " unlocked";
			else
				resp.message = "Layer " + req.layerPath + " locked";
		}
		else
		{
			resp.status = "error";
			resp.message = "Unknown action: " + req.action + ". Valid: list, getActive, create, setActive, getEntityLayer, isVisible, getInfo, toggleLock";
		}

		return resp;
	}
}
