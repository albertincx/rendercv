importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.1/full/pyodide.js");

let pyodideInstance = null;

// Notify parent that worker is loaded
self.postMessage({ type: "worker_loaded" });

async function initPyodide(wheelBuffer) {
    try {
        self.postMessage({ type: "status", status: "loading", message: "Loading Python environment (Pyodide)..." });
        pyodideInstance = await loadPyodide();
        
        self.postMessage({ type: "status", status: "loading", message: "Loading precompiled Pydantic and YAML..." });
        await pyodideInstance.loadPackage(["pydantic", "ruamel.yaml"]);

        self.postMessage({ type: "status", status: "loading", message: "Loading micropip package manager..." });
        await pyodideInstance.loadPackage("micropip");
        
        self.postMessage({ type: "status", status: "loading", message: "Installing dependencies..." });
        
        const micropip = pyodideInstance.pyimport("micropip");
        
        // Install from Pyodide's pre-compiled package index and remote wheel
        await micropip.install([
            "email-validator",
            "jinja2",
            "markdown",
            "phonenumbers",
            "pydantic-extra-types"
        ]);
        
        self.postMessage({ type: "status", status: "loading", message: "Extracting RenderCV wheel package..." });
        
        // Write the wheel buffer to Pyodide FS and extract it directly
        pyodideInstance.FS.writeFile("/tmp/rendercv-2.8-py3-none-any.whl", new Uint8Array(wheelBuffer));
        pyodideInstance.runPython(`
import zipfile
with zipfile.ZipFile('/tmp/rendercv-2.8-py3-none-any.whl', 'r') as zip_ref:
    zip_ref.extractall('/lib/python3.12/site-packages')
        `);
        
        self.postMessage({ type: "status", status: "loading", message: "Initializing RenderCV Python workspace..." });
        
        // Define Python wrapper functions in Pyodide namespace
        pyodideInstance.runPython(`
import io
import json
import pathlib
import ruamel.yaml
import pydantic
from rendercv.schema.rendercv_model_builder import (
    build_rendercv_dictionary,
    build_rendercv_model_from_commented_map,
)
from rendercv.renderer.templater.templater import render_full_template
from rendercv.schema.sample_generator import create_sample_yaml_input_file
from rendercv.exception import RenderCVUserValidationError, RenderCVUserError

def py_render(yaml_str, hide_sections_json):
    try:
        hide_sections = json.loads(hide_sections_json)
        tmp_path = pathlib.Path("/tmp")
        
        # Build dictionary
        input_dict, overlay_sources = build_rendercv_dictionary(
            yaml_str,
            output_folder=tmp_path,
            dont_generate_png=True,
            dont_generate_markdown=True,
            dont_generate_html=True,
        )
        
        # Get all sections
        all_sections = []
        if "cv" in input_dict and "sections" in input_dict["cv"] and input_dict["cv"]["sections"]:
            all_sections = list(input_dict["cv"]["sections"].keys())
            
        # Programmatically remove hidden sections
        if hide_sections:
            for sec in hide_sections:
                if "cv" in input_dict and "sections" in input_dict["cv"] and input_dict["cv"]["sections"]:
                    input_dict["cv"]["sections"].pop(sec, None)
                    
        # Validate and build model
        model = build_rendercv_model_from_commented_map(input_dict, tmp_path, overlay_sources)
        
        # Render Typst markup
        typst_code = render_full_template(model, "typst")
        
        return json.dumps({
            "status": "success",
            "typst": typst_code,
            "sections": all_sections
        })
    except RenderCVUserValidationError as e:
        errors = []
        for err in e.validation_errors:
            start_line = err.yaml_location[0][0] if err.yaml_location else None
            start_col = err.yaml_location[0][1] if err.yaml_location else None
            errors.append({
                "message": err.message,
                "line": start_line,
                "col": start_col,
                "schema_location": err.schema_location
            })
        return json.dumps({
            "status": "error",
            "type": "validation_error",
            "detail": "YAML validation failed",
            "errors": errors
        })
    except RenderCVUserError as e:
        return json.dumps({
            "status": "error",
            "type": "user_error",
            "detail": str(getattr(e, 'message', e) or e)
        })
    except Exception as e:
        import traceback
        return json.dumps({
            "status": "error",
            "type": "internal_error",
            "detail": f"An unexpected error occurred during rendering: {e!s}",
            "traceback": "".join(traceback.format_exception(type(e), e, e.__traceback__))
        })

def py_switch_theme(yaml_str, theme):
    try:
        ryaml = ruamel.yaml.YAML()
        ryaml.preserve_quotes = True
        ryaml.indent(mapping=2, sequence=4, offset=2)
        
        current_data = ryaml.load(yaml_str)
        if not isinstance(current_data, dict):
            raise ValueError("YAML must represent a mapping structure.")
            
        new_theme_yaml = create_sample_yaml_input_file(file_path=None, name="John Doe", theme=theme)
        new_data = ryaml.load(new_theme_yaml)
        
        if current_data.get("cv"):
            new_data["cv"] = current_data["cv"]
            
        with io.StringIO() as stream:
            ryaml.dump(new_data, stream)
            merged = stream.getvalue()
            
        return json.dumps({
            "status": "success",
            "yaml": merged
        })
    except Exception as e:
        return json.dumps({
            "status": "error",
            "detail": str(e)
        })

def py_load_theme(theme):
    try:
        yaml_content = create_sample_yaml_input_file(file_path=None, name="John Doe", theme=theme)
        return json.dumps({
            "status": "success",
            "yaml": yaml_content
        })
    except Exception as e:
        return json.dumps({
            "status": "error",
            "detail": str(e)
        })
        `);
        
        self.postMessage({ type: "status", status: "ready", message: "RenderCV is ready" });
    } catch (e) {
        console.error(e);
        self.postMessage({ type: "status", status: "error", error: e.message });
    }
}

self.onmessage = async function(event) {
    const data = event.data;
    if (data.type === "init") {
        await initPyodide(data.wheelBuffer);
    } else if (data.type === "render") {
        if (!pyodideInstance) {
            self.postMessage({ type: "render_response", id: data.id, error: "Pyodide not initialized" });
            return;
        }
        try {
            const pyRender = pyodideInstance.globals.get("py_render");
            const resultJson = pyRender(data.yaml, JSON.stringify(data.hideSections));
            const result = JSON.parse(resultJson);
            self.postMessage({ type: "render_response", id: data.id, result: result });
        } catch (err) {
            self.postMessage({ type: "render_response", id: data.id, error: err.message });
        }
    } else if (data.type === "switch_theme") {
        if (!pyodideInstance) {
            self.postMessage({ type: "switch_theme_response", id: data.id, error: "Pyodide not initialized" });
            return;
        }
        try {
            const pySwitchTheme = pyodideInstance.globals.get("py_switch_theme");
            const resultJson = pySwitchTheme(data.yaml, data.theme);
            const result = JSON.parse(resultJson);
            self.postMessage({ type: "switch_theme_response", id: data.id, result: result });
        } catch (err) {
            self.postMessage({ type: "switch_theme_response", id: data.id, error: err.message });
        }
    } else if (data.type === "load_theme") {
        if (!pyodideInstance) {
            self.postMessage({ type: "load_theme_response", id: data.id, error: "Pyodide not initialized" });
            return;
        }
        try {
            const pyLoadTheme = pyodideInstance.globals.get("py_load_theme");
            const resultJson = pyLoadTheme(data.theme);
            const result = JSON.parse(resultJson);
            self.postMessage({ type: "load_theme_response", id: data.id, result: result });
        } catch (err) {
            self.postMessage({ type: "load_theme_response", id: data.id, error: err.message });
        }
    }
};
