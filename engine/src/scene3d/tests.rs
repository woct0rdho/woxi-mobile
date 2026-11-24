use super::scene3d;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use woxi::syntax::Expr;

fn scene(statement: &str) -> Option<String> {
    woxi::clear_state();
    woxi::interpret_with_stdout(statement).ok()?;
    let output = woxi::get_last_output()?;
    scene3d(&output, statement)
}

fn field<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let start = json.find(key)? + key.len();
    let rest = &json[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn base64_f32(json: &str, key: &str) -> Vec<f32> {
    let bytes = BASE64.decode(field(json, key).expect(key)).expect("base64");
    let (chunks, _) = bytes.as_chunks::<4>();
    chunks
        .iter()
        .map(|chunk| f32::from_le_bytes(*chunk))
        .collect()
}

fn base64_u32(json: &str, key: &str) -> Vec<u32> {
    let bytes = BASE64.decode(field(json, key).expect(key)).expect("base64");
    let (chunks, _) = bytes.as_chunks::<4>();
    chunks
        .iter()
        .map(|chunk| u32::from_le_bytes(*chunk))
        .collect()
}

fn base64_u8(json: &str, key: &str) -> Vec<u8> {
    BASE64.decode(field(json, key).expect(key)).expect("base64")
}

fn segment_count(json: &str) -> usize {
    base64_f32(json, "\"lines\":\"").len() / 6
}

fn face_count(json: &str) -> usize {
    base64_u32(json, "\"indices\":\"").len() / 3
}

#[test]
fn every_scene_has_finite_in_range_geometry() {
    for statement in [
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]",
        "ContourPlot3D[x^2 + y^2 + z^2 == 1, {x, -1.2, 1.2}, {y, -1.2, 1.2}, {z, -1.2, 1.2}]",
        "SphericalPlot3D[1 + 0.3 Sin[5 t] Sin[6 p], {t, 0, Pi}, {p, 0, 2 Pi}]",
    ] {
        let json = scene(statement).expect(statement);
        let vertices = base64_f32(&json, "\"vertices\":\"");
        let indices = base64_u32(&json, "\"indices\":\"");
        let colors = base64_u8(&json, "\"colors\":\"");
        assert_eq!(vertices.len() % 3, 0, "{statement}");
        assert_eq!(indices.len() % 3, 0, "{statement}");
        assert_eq!(colors.len() % 4, 0, "{statement}");
        let vertex_count = vertices.len() / 3;
        let face_count = indices.len() / 3;
        assert_eq!(colors.len() / 4, face_count, "{statement}");
        assert!(
            vertices.iter().all(|value| value.is_finite()),
            "{statement}"
        );
        assert!(
            indices.iter().all(|index| (*index as usize) < vertex_count),
            "{statement}"
        );
        assert!(face_count > 0, "{statement}");
    }
}

#[test]
fn the_option_matrix_keeps_unsupported_options_static() {
    for statement in [
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Filling -> Bottom]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, AxesLabel -> {\"x\", \"y\", \"z\"}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Ticks -> None]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ViewPoint -> {0, 0, 3}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotLabel -> \"surface\"]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotStyle -> Directive[Red, Thick]]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotStyle -> RGBColor[1, 0]]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotStyle -> Opacity[Red]]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Mesh -> All]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, AxesLabel -> Automatic]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotLabel -> Automatic]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotLegends -> Automatic]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotLabels -> Automatic]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, BoxRatios -> {1, 1, 1}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Axes -> False]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Mesh -> 3]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, MeshFunctions -> {#1 &}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ViewProjection -> \"Bogus\"]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, MeshShading -> {Red, Blue}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Background -> None]",
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, MeshShading -> {Red, Blue}]",
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, BoxRatios -> {1, 2}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, RegionFunction -> Function[{x, y, z}, x^2 + y^2 < 1]]",
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, RegionFunction -> Function[{x, y, z, u, v}, u < 1 || u > 2]]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotRange -> 2]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, AspectRatio -> Automatic]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Texture -> Automatic]",
        "ListPlot3D[Table[Sin[i/5] Cos[j/5], {i, 0, 10}, {j, 0, 10}], Boxed -> False]",
        "ListPlot3D[Table[Sin[i/5] Cos[j/5], {i, 0, 10}, {j, 0, 10}], PlotRange -> {{0, 5}, {0, 10}, {-0.5, 0.5}}]",
        "ListPlot3D[Table[Sin[i/5] Cos[j/5], {i, 0, 10}, {j, 0, 10}], PlotRange -> 2]",
        "ContourPlot3D[x^2 + y^2 + z^2 == 1, {x, -1.2, 1.2}, {y, -1.2, 1.2}, {z, -1.2, 1.2}, BoxRatios -> {1, 2, 3}]",
        "RegionPlot3D[x^2 + y^2 + z^2 <= 1, {x, -1, 1}, {y, -1, 1}, {z, -1, 1}, BoxRatios -> {1, 2, 3}]",
        "ContourPlot3D[x^2 + y^2 + z^2 == 1, {x, -1.2, 1.2}, {y, -1.2, 1.2}, {z, -1.2, 1.2}, PlotRange -> {{-2, 2}, {-2, 2}, {-2, 2}}]",
        "ContourPlot3D[x^2 + y^2 + z^2 == 1, {x, -1.2, 1.2}, {y, -1.2, 1.2}, {z, -1.2, 1.2}, Axes -> False]",
        "RegionPlot3D[x^2 + y^2 + z^2 <= 1, {x, -1, 1}, {y, -1, 1}, {z, -1, 1}, PlotRange -> {{-2, 2}, {-2, 2}, {-2, 2}}]",
        "RegionPlot3D[x^2 + y^2 + z^2 <= 1, {x, -1, 1}, {y, -1, 1}, {z, -1, 1}, Axes -> False]",
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, PlotRange -> 2]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {Automatic}]",
    ] {
        assert!(scene(statement).is_none(), "{statement}");
    }
    for statement in [
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotStyle -> Red]",
        "Plot3D[Sin[x] Cos[y], {x, 0, 3}, {y, 0, 3}, ColorFunction -> \"Rainbow\"]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Mesh -> None]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Mesh -> False]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, MeshStyle -> None]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Axes -> True]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Boxed -> False]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Filling -> None]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Ticks -> Automatic]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> 200]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {320}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {Automatic, 200}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {300, Automatic}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {Automatic, Automatic}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> 2 {300, 200}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> Automatic]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotRange -> Automatic]",
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, BoxRatios -> Automatic]",
        "SphericalPlot3D[1 + 0.3 Sin[5 t] Sin[6 p], {t, 0, Pi}, {p, 0, 2 Pi}, Axes -> False]",
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, BoxRatios -> {1, 1, 1}]",
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, PlotRange -> {{-4, 4}, {-4, 4}, {-2, 2}}]",
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, Mesh -> 3]",
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, Mesh -> -1]",
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, Mesh -> False]",
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, MeshStyle -> None]",
        "SphericalPlot3D[1 + 0.3 Sin[5 t] Sin[6 p], {t, 0, Pi}, {p, 0, 2 Pi}, BoxRatios -> {1, 2, 3}]",
        "SphericalPlot3D[1 + 0.3 Sin[5 t] Sin[6 p], {t, 0, Pi}, {p, 0, 2 Pi}, PlotRange -> {{-2, 2}, {-2, 2}, {-2, 2}}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotRange -> {{-2, 2}, {-1, 1}, {-0.5, 0.5}}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotRange -> {{-2 Pi, 2 Pi}, {-Pi, Pi}, {-1, 1}}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ViewProjection -> \"Orthographic\"]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ViewProjection -> \"Orthographic\", ViewPoint -> {0, 0, 3}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ViewProjection -> \"Perspective\"]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ViewPoint -> {0, 0, Infinity}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ViewProjection -> Automatic]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotRange -> {-0.5, 0.5}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, BoundaryStyle -> Automatic]",
        "SphericalPlot3D[1 + 0.3 Sin[5 t] Sin[6 p], {t, 0, Pi}, {p, 0, 2 Pi}, PlotRange -> {-2, 2}]",
    ] {
        assert!(scene(statement).is_some(), "{statement}");
    }
    let boxed = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Boxed -> False]")
        .expect("boxed scene");
    assert!(boxed.contains("\"axes\":false"), "{boxed}");
    assert!(boxed.contains("\"boxed\":false"), "{boxed}");

    let orthographic =
        scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ViewProjection -> \"Orthographic\"]")
            .expect("orthographic scene");
    assert!(
        orthographic.contains("\"perspective\":false"),
        "{orthographic}"
    );
    assert!(orthographic.contains("\"az\":-1.07"), "{orthographic}");

    let orthographic_point = scene(
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ViewProjection -> \"Orthographic\", ViewPoint -> {0, 0, 3}]",
    )
    .expect("orthographic point view scene");
    assert!(
        orthographic_point.contains("\"perspective\":false"),
        "{orthographic_point}"
    );
    assert!(
        orthographic_point.contains("\"el\":1.5707963267948966"),
        "{orthographic_point}"
    );

    let perspective =
        scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ViewProjection -> \"Perspective\"]")
            .expect("perspective scene");
    assert!(
        perspective.contains("\"perspective\":true"),
        "{perspective}"
    );

    let top = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ViewPoint -> {0, 0, Infinity}]")
        .expect("top orthographic scene");
    assert!(top.contains("\"perspective\":false"), "{top}");
    assert!(top.contains("\"el\":1.5707963267948966"), "{top}");

    let spherical_axes = scene(
        "SphericalPlot3D[1 + 0.3 Sin[5 t] Sin[6 p], {t, 0, Pi}, {p, 0, 2 Pi}, Axes -> False]",
    )
    .expect("spherical axes scene");
    assert!(
        spherical_axes.contains("\"axes\":false"),
        "{spherical_axes}"
    );
    assert!(
        spherical_axes.contains("\"boxed\":true"),
        "{spherical_axes}"
    );
}

fn digest(statement: &str) -> Option<String> {
    let json = scene(statement)?;
    let card = json.split("\"card\":").nth(1)?;
    let card = &card[..card.find("}}")? + 1];
    Some(format!(
        "faces={} segments={} box={} camera={} ranges={} axes={} boxed={} coverage={} card={}",
        face_count(&json),
        segment_count(&json),
        json.split("\"box\":")
            .nth(1)?
            .split(",\"vertices\"")
            .next()?,
        json.split("\"camera\":")
            .nth(1)?
            .split(",\"ranges\"")
            .next()?,
        json.split("\"ranges\":").nth(1)?.split(",\"box\"").next()?,
        json.split("\"axes\":").nth(1)?.split(',').next()?,
        json.split("\"boxed\":").nth(1)?.split(',').next()?,
        json.split("\"coverage\":")
            .nth(1)?
            .split(",\"card\"")
            .next()?,
        card,
    ))
}

fn camera_distance(json: &str) -> f64 {
    json.split("\"camera\":")
        .nth(1)
        .and_then(|rest| rest.split("\"dist\":").nth(1))
        .and_then(|rest| rest.split(',').next())
        .and_then(|value| value.parse().ok())
        .expect("camera distance")
}

#[test]
fn the_default_camera_uses_woxis_view_point_norm() {
    let json = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]").expect("Plot3D scene");
    let expected = 2.0 * (1.3_f64 * 1.3 + 2.4_f64 * 2.4 + 2.0_f64 * 2.0).sqrt();
    assert!((camera_distance(&json) - expected).abs() < 1e-12, "{json}");
}

#[test]
fn a_plot3d_scene_gets_the_default_boundary() {
    let json = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]").expect("Plot3D scene");
    assert_eq!(segment_count(&json), 1900, "{json}");
    let colors = base64_u8(&json, "\"lineColors\":\"");
    assert_eq!(colors.len(), segment_count(&json) * 8, "{json}");
    assert_eq!(&colors[colors.len() - 8..], &[0, 0, 0, 255, 0, 0, 0, 255]);

    let without = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, BoundaryStyle -> None]")
        .expect("boundary-free Plot3D scene");
    assert_eq!(segment_count(&without), 1700, "{without}");
}

#[test]
fn a_spherical_z_only_range_is_a_scene() {
    let json = scene(
        "SphericalPlot3D[1 + 0.3 Sin[5 t] Sin[6 p], {t, 0, Pi}, {p, 0, 2 Pi}, PlotRange -> {-2, 2}]",
    )
    .expect("spherical z-only range");
    assert!(json.contains("\"ranges\":[["), "{json}");
    assert!(json.contains(",[-2,2]]"), "{json}");
}

#[test]
fn every_line_endpoint_carries_a_colour() {
    let json = scene(
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}]",
    )
    .expect("parametric scene");
    let colors = base64_u8(&json, "\"lineColors\":\"");
    assert_eq!(colors.len(), segment_count(&json) * 8, "{json}");
}

#[test]
fn the_scene_fingerprint_matches_the_fixture() {
    let scenes = [
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]",
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ColorFunction -> \"Rainbow\"]",
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}]",
        "ContourPlot3D[x^2 + y^2 + z^2 == 1, {x, -1.2, 1.2}, {y, -1.2, 1.2}, {z, -1.2, 1.2}]",
        "SphericalPlot3D[1 + 0.3 Sin[5 t] Sin[6 p], {t, 0, Pi}, {p, 0, 2 Pi}]",
    ];
    let mut actual = String::new();
    for statement in scenes {
        actual.push_str(statement);
        actual.push_str("\n  ");
        actual.push_str(&digest(statement).unwrap_or_else(|| "none".to_string()));
        actual.push('\n');
    }
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/scenes3d.txt"
    );
    if std::env::var_os("WOXI_UPDATE_SCENES3D").is_some() {
        std::fs::write(path, &actual).expect("write scene fixture");
        return;
    }
    let expected = std::fs::read_to_string(path).expect("read scene fixture");
    assert_eq!(actual, expected, "scene fingerprints changed");
}

#[test]
fn a_scene_that_would_lose_f32_precision_is_static() {
    assert!(
        scene("Plot3D[1*^12 + x + y, {x, 0, 1}, {y, 0, 1}]").is_none(),
        "huge offset"
    );
    // The coverage is wide enough that a coverage-relative check would accept
    // it, but the visible x span is one unit and f32 cannot resolve it here.
    let narrow = scene(
        "ParametricPlot3D[{1*^6 + 1000 u + 0.03, v, Sin[2 Pi u]}, {u, 0, 1}, {v, 0, 1}, PlotRange -> {{1*^6, 1*^6 + 1}, {0, 1}, {-1, 1}}, BoxRatios -> {1, 1, 1}]",
    );
    assert!(narrow.is_none(), "narrow view loses precision");
}

#[test]
fn the_spherical_default_uses_graphics3d_padding_and_proportions() {
    let sphere = scene("SphericalPlot3D[1 + 0.3 Sin[5 t] Sin[6 p], {t, 0, Pi}, {p, 0, 2 Pi}]")
        .expect("spherical scene");
    assert!(sphere.contains("\"ranges\":"), "{sphere}");
    assert!(sphere.contains("\"box\":[1,"), "{sphere}");
}

#[test]
fn explicit_ranges_shape_the_spherical_and_parametric_boxes() {
    let spherical = scene(
        "SphericalPlot3D[1 + 0.3 Sin[5 t] Sin[6 p], {t, 0, Pi}, {p, 0, 2 Pi}, PlotRange -> {{-4, 4}, {-2, 2}, {-1, 3}}]",
    )
    .expect("spherical explicit range");
    assert!(
        spherical.contains("\"ranges\":[[-4,4],[-2,2],[-1,3]]"),
        "{spherical}"
    );
    assert!(spherical.contains("\"box\":[1,0.5,0.5]"), "{spherical}");

    let parametric = scene(
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, PlotRange -> {{-4, 4}, {-4, 4}, {-2, 2}}]",
    )
    .expect("parametric explicit range");
    assert!(parametric.contains("\"box\":[1,1,0.5]"), "{parametric}");
}

#[test]
fn spherical_keeps_axes_when_the_box_is_hidden() {
    let scene = scene(
        "SphericalPlot3D[1 + 0.3 Sin[5 t] Sin[6 p], {t, 0, Pi}, {p, 0, 2 Pi}, Boxed -> False]",
    )
    .expect("unboxed spherical scene");
    assert!(scene.contains("\"boxed\":false"), "{scene}");
    assert!(scene.contains("\"axes\":true"), "{scene}");
}

#[test]
fn a_plot3d_domain_is_not_narrowed_when_one_intersection_is_empty() {
    let scene =
        scene("Plot3D[x + y, {x, 0, 1}, {y, 0, 1}, PlotRange -> {{0.2, 0.8}, {10, 11}, {-1, 1}}]")
            .expect("one-axis plot range scene");
    assert!(scene.contains("\"ranges\":[[0,1],[0,1],[-1,1]]"), "{scene}");
}

#[test]
fn delayed_options_keep_the_picture_static() {
    assert!(scene(
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotRange :> {{-1, 1}, {-1, 1}, {-1, 1}}]"
    )
    .is_none());
}

#[test]
fn parametric_default_mesh_can_be_suppressed() {
    let with_mesh = scene(
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}]",
    )
    .expect("default parametric mesh");
    let without_mesh = scene(
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, Mesh -> None]",
    )
    .expect("no parametric mesh");
    let styled_mesh = scene(
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, Mesh -> 3]",
    )
    .expect("counted parametric mesh");
    let hidden_mesh = scene(
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, MeshStyle -> None]",
    )
    .expect("hidden parametric mesh");
    let false_mesh = scene(
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, Mesh -> False]",
    )
    .expect("false mesh");
    let negative_mesh = scene(
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, Mesh -> -1]",
    )
    .expect("negative mesh");
    let shaded_mesh = scene(
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, MeshShading -> {Red, Blue}]",
    );
    assert!(shaded_mesh.is_none(), "{shaded_mesh:?}");
    assert_eq!(segment_count(&with_mesh), 1700, "{with_mesh}");
    assert_eq!(segment_count(&without_mesh), 0, "{without_mesh}");
    assert!(segment_count(&styled_mesh) > 0, "{styled_mesh}");
    assert_eq!(segment_count(&hidden_mesh), 0, "{hidden_mesh}");
    assert_eq!(segment_count(&false_mesh), 1700, "{false_mesh}");
    assert_eq!(segment_count(&negative_mesh), 1700, "{negative_mesh}");
}

#[test]
fn empty_style_forms_keep_the_default_mesh_and_boundary() {
    let default_mesh = scene(
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}]",
    )
    .expect("default parametric mesh");
    let false_mesh = scene(
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, MeshStyle -> False]",
    )
    .expect("false mesh style");
    let empty_mesh = scene(
        "ParametricPlot3D[{Cos[u] (2 + Cos[v]), Sin[u] (2 + Cos[v]), Sin[v]}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, MeshStyle -> {}]",
    )
    .expect("empty mesh style");
    assert_eq!(segment_count(&default_mesh), 1700, "{default_mesh}");
    assert_eq!(segment_count(&false_mesh), 1700, "{false_mesh}");
    assert_eq!(segment_count(&empty_mesh), 1700, "{empty_mesh}");

    let default_boundary =
        scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]").expect("default Plot3D boundary");
    let false_boundary =
        scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, BoundaryStyle -> False]")
            .expect("false boundary style");
    let empty_boundary =
        scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, BoundaryStyle -> {}]")
            .expect("empty boundary style");
    assert_eq!(segment_count(&default_boundary), 1900, "{default_boundary}");
    assert_eq!(segment_count(&false_boundary), 1900, "{false_boundary}");
    assert_eq!(segment_count(&empty_boundary), 1900, "{empty_boundary}");
}

#[test]
fn a_quad_uses_the_standalone_renderer_diagonal() {
    let json = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]").expect("Plot3D is a scene");
    let indices = base64_u32(&json, "\"indices\":\"");
    // Woxi's first Plot3D quad is indices 1,52,53,2. Its standalone
    // renderer splits it on 52-2, not on 1-53.
    assert_eq!(&indices[..6], &[0, 51, 1, 52, 1, 51]);
}

#[test]
fn parametric_default_surfaces_use_the_theme_palette() {
    let json = scene(
        "ParametricPlot3D[{{Cos[u] Cos[v], Sin[u] Cos[v], Sin[v]}, {Cos[u] Sin[v], Sin[u] Sin[v], Cos[v]}}, {u, 0, 2 Pi}, {v, 0, 2 Pi}]",
    )
    .expect("two parametric surfaces");
    let colors = base64_u8(&json, "\"colors\":\"");
    let mut palette = std::collections::BTreeSet::new();
    for color in colors.as_chunks::<4>().0 {
        palette.insert([color[0], color[1], color[2]]);
    }
    assert!(palette.contains(&[225, 156, 36]), "{palette:?}");
    assert!(palette.contains(&[94, 129, 181]), "{palette:?}");
}

#[test]
fn an_explicit_default_color_is_not_replaced_by_the_palette() {
    let json = scene(
        "ParametricPlot3D[{{Cos[u] Cos[v], Sin[u] Cos[v], Sin[v]}, {Cos[u] Sin[v], Sin[u] Sin[v], Cos[v]}}, {u, 0, 2 Pi}, {v, 0, 2 Pi}, PlotStyle -> {Red, RGBColor[0.8823529411764706, 0.611764705882353, 0.1411764705882353]}]",
    )
    .expect("explicit default color surface");
    let colors = base64_u8(&json, "\"colors\":\"");
    let has = |needle: [u8; 3]| {
        colors
            .as_chunks::<4>()
            .0
            .iter()
            .any(|color| color[0..3] == needle)
    };
    assert!(has([225, 156, 36]), "explicit default color is missing");
    assert!(!has([94, 129, 181]), "second palette color leaked in");
}

#[test]
fn a_malformed_line_makes_the_scene_static() {
    let complex = woxi::syntax::string_to_expr(
        "GraphicsComplex[{{0,0,0},{1,0,0},{0,1,0}}, {Polygon[{1,2,3}], Line[{{1,2},{3,\"x\"}}]}]",
    )
    .expect("malformed line expression");
    let mut extract = super::Extract::new(false);
    assert!(!extract.walk(&complex));
}

#[test]
fn a_vertex_colour_complex_option_is_not_silently_dropped() {
    let complex = woxi::syntax::string_to_expr(
        "GraphicsComplex[{{0,0,0},{1,0,0},{0,1,0}}, {Polygon[{1,2,3}]}, VertexColors -> {{1,0,0},{0,1,0},{0,0,1}}]",
    )
    .expect("vertex colour complex");
    let mut extract = super::Extract::new(false);
    assert!(!extract.walk(&complex));
}

#[test]
fn redundant_vertex_normals_are_accepted() {
    let complex = woxi::syntax::string_to_expr(
        "GraphicsComplex[{{0,0,0},{1,0,0},{0,1,0}}, {Polygon[{1,2,3}]}, VertexNormals -> {{0,0,1},{0,0,1},{0,0,1}}]",
    )
    .expect("vertex normal complex");
    let mut extract = super::Extract::new(false);
    assert!(extract.walk(&complex));
    assert_eq!(extract.faces.len(), 1);
}

#[test]
fn a_texture_directive_makes_the_scene_static() {
    let complex = woxi::syntax::string_to_expr(
        "GraphicsComplex[{{0,0,0},{1,0,0},{0,1,0}}, {Texture[\"texture\"], Polygon[{1,2,3}]}]",
    )
    .expect("textured complex");
    let mut extract = super::Extract::new(false);
    assert!(!extract.walk(&complex));
}

#[test]
fn a_surface_has_vertices_faces_and_lines() {
    let scene = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]").expect("Plot3D is a scene");
    assert_eq!(face_count(&scene), 5000, "{scene}");
    assert!(segment_count(&scene) > 0, "{scene}");
    assert!(scene.contains("\"camera\":{"), "{scene}");
    assert!(scene.contains("\"box\":[1,1,0.4]"), "{scene}");
    assert!(scene.contains("\"coverage\":"), "{scene}");
    assert!(scene.contains("\"theme\":"), "{scene}");
    assert!(!scene.contains("\"lineColor\""), "{scene}");
    assert!(!scene.contains("\"space\""), "{scene}");
    assert!(!scene.contains("<svg"), "{scene}");
}

#[test]
fn the_original_plot_range_and_image_size_shape_the_view() {
    let surface = scene(
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotRange -> {{-2, 2}, {-1, 1}, {-0.5, 0.5}}, ImageSize -> {300, 200}]",
    )
    .expect("explicit range scene");
    assert!(
        surface.contains("\"ranges\":[[-2,2],[-1,1],[-0.5,0.5]]"),
        "{surface}"
    );
    assert!(
        surface.contains("\"card\":{\"width\":300,\"height\":200,\"full\":false}"),
        "{surface}"
    );

    let bare = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> 320]")
        .expect("bare width scene");
    assert!(
        bare.contains("\"card\":{\"width\":320,\"height\":null,\"full\":false}"),
        "{bare}"
    );

    let one = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {320}]")
        .expect("one-element size scene");
    assert!(
        one.contains("\"card\":{\"width\":320,\"height\":null,\"full\":false}"),
        "{one}"
    );

    let height =
        scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {Automatic, 200}]")
            .expect("height-only card scene");
    assert!(
        height.contains("\"card\":{\"width\":200,\"height\":200,\"full\":false}"),
        "{height}"
    );

    let width =
        scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {300, Automatic}]")
            .expect("width-only pair scene");
    assert!(
        width.contains("\"card\":{\"width\":300,\"height\":300,\"full\":false}"),
        "{width}"
    );

    let named = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> Small]")
        .expect("named size scene");
    assert!(
        named.contains("\"card\":{\"width\":180,\"height\":null,\"full\":false}"),
        "{named}"
    );

    let full = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> Full]")
        .expect("full width scene");
    assert!(
        full.contains("\"card\":{\"width\":null,\"height\":null,\"full\":true}"),
        "{full}"
    );

    let both_automatic =
        scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {Automatic, Automatic}]")
            .expect("both automatic card scene");
    assert!(
        both_automatic.contains("\"card\":{\"width\":360,\"height\":360,\"full\":false}"),
        "{both_automatic}"
    );

    let multiplied =
        scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> 2 {300, 200}]")
            .expect("multiplied image size");
    assert!(
        multiplied.contains("\"card\":{\"width\":600,\"height\":400,\"full\":false}"),
        "{multiplied}"
    );

    let named_list = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {Full}]")
        .expect("one-element named size scene");
    assert!(
        named_list.contains("\"card\":{\"width\":null,\"height\":null,\"full\":true}"),
        "{named_list}"
    );

    let small_list = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {Small}]")
        .expect("one-element Small size scene");
    assert!(
        small_list.contains("\"card\":{\"width\":180,\"height\":null,\"full\":false}"),
        "{small_list}"
    );

    let tiny_list = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {Tiny}]")
        .expect("one-element Tiny size scene");
    assert!(
        tiny_list.contains("\"card\":{\"width\":100,\"height\":null,\"full\":false}"),
        "{tiny_list}"
    );

    let ranged = scene(
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {{300, 400}, {200, 300}}]",
    )
    .expect("range image size scene");
    assert!(
        ranged.contains("\"card\":{\"width\":300,\"height\":300,\"full\":false}"),
        "{ranged}"
    );

    let up_to =
        scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> {UpTo[300], UpTo[200]}]")
            .expect("UpTo pair image size");
    assert!(
        up_to.contains("\"card\":{\"width\":300,\"height\":200,\"full\":false}"),
        "{up_to}"
    );

    let list = scene(
        "ListPlot3D[Table[Sin[i/5] Cos[j/5], {i, 0, 10}, {j, 0, 10}], PlotRange -> {-0.5, 0.5}]",
    )
    .expect("list scene");
    assert!(list.contains("\"coverage\":"), "{list}");
    assert!(list.contains("\"box\":[1,1,0.4]"), "{list}");
    assert!(
        list.contains("\"ranges\":[[1,11],[1,11],[-0.5,0.5]]"),
        "{list}"
    );

    let height_only =
        scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotRange -> {-0.5, 0.5}]")
            .expect("height-only range scene");
    assert!(
        height_only.contains("\"ranges\":[[-3,3],[-3,3],[-0.5,0.5]]"),
        "{height_only}"
    );

    let widened = scene(
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotRange -> {{-2 Pi, 2 Pi}, {-Pi, Pi}, {-1, 1}}]",
    )
    .expect("widened range scene");
    assert!(
        widened.contains("\"ranges\":[[-3,3],[-3,3],[-1,1]]"),
        "{widened}"
    );
}

#[test]
fn a_later_option_wins_after_parsing() {
    let automatic = scene(
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotRange -> {{-1, 1}, {-1, 1}, {-1, 1}}, PlotRange -> Automatic]",
    )
    .expect("automatic range scene");
    assert!(
        automatic.contains("\"ranges\":[[-3,3],[-3,3],["),
        "{automatic}"
    );

    let explicit = scene(
        "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, PlotRange -> Automatic, PlotRange -> {{-1, 1}, {-1, 1}, {-1, 1}}]",
    )
    .expect("explicit range scene");
    assert!(
        explicit.contains("\"ranges\":[[-1,1],[-1,1],[-1,1]]"),
        "{explicit}"
    );
}

#[test]
fn the_plot_domain_shapes_the_view_even_when_the_surface_is_smaller() {
    let contour = scene("ContourPlot3D[x == 0, {x, -1.2, 1.2}, {y, -1.2, 1.2}, {z, -1.2, 1.2}]")
        .expect("plane contour scene");
    assert!(
        contour.contains("\"ranges\":[[-1.2,1.2],[-1.2,1.2],[-1.2,1.2]]"),
        "{contour}"
    );

    let region = scene("RegionPlot3D[x^2 + y^2 + z^2 <= 1, {x, -2, 2}, {y, -2, 2}, {z, -2, 2}]")
        .expect("region scene");
    assert!(
        region.contains("\"ranges\":[[-2,2],[-2,2],[-2,2]]"),
        "{region}"
    );
    assert!(region.contains("\"box\":[1,1,1]"), "{region}");

    let list =
        scene("ListPlot3D[Table[Sin[i/5] Cos[j/5], {i, 0, 10}, {j, 0, 10}]]").expect("list scene");
    assert!(list.contains("\"box\":[1,1,0.4]"), "{list}");

    let sphere = scene("SphericalPlot3D[1 + 0.8 Cos[t], {t, 0, Pi}, {p, 0, 2 Pi}]")
        .expect("spherical scene");
    assert!(segment_count(&sphere) > 0, "{sphere}");
    assert!(!sphere.contains("\"box\":[1,1,1]"), "{sphere}");
}

#[test]
fn vertices_are_in_data_space_not_normalized_box_space() {
    let json = scene("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]").expect("Plot3D is a scene");
    let vertices = base64_f32(&json, "\"vertices\":\"");
    let min_x = vertices
        .as_chunks::<3>()
        .0
        .iter()
        .map(|point| point[0])
        .fold(f32::INFINITY, f32::min);
    assert!(min_x <= -2.9, "min x = {min_x}");
}

#[test]
fn a_multipolygon_contour_is_a_scene() {
    let scene = scene(
        "ContourPlot3D[x^2 + y^2 + z^2 == 1, {x, -1.2, 1.2}, {y, -1.2, 1.2}, {z, -1.2, 1.2}]",
    )
    .expect("ContourPlot3D is a scene");
    assert!(face_count(&scene) > 0, "{scene}");
    assert!(scene.contains("\"vertices\":\""), "{scene}");
}

#[test]
fn a_spherical_surface_is_a_scene() {
    let scene = scene("SphericalPlot3D[1 + 0.3 Sin[5 t] Sin[6 p], {t, 0, Pi}, {p, 0, 2 Pi}]")
        .expect("SphericalPlot3D is a scene");
    assert!(face_count(&scene) > 0, "{scene}");
    assert!(scene.contains("\"vertices\":\""), "{scene}");
}

#[test]
fn a_literal_spherical_polygon_is_a_scene() {
    let scene = scene("SphericalPlot3D[1, {t, 0, Pi}, {p, 0, 2 Pi}]")
        .expect("literal SphericalPlot3D is a scene");
    assert!(face_count(&scene) > 0, "{scene}");
}

#[test]
fn a_region_and_a_list_surface_are_scenes() {
    let region = scene("RegionPlot3D[x^2 + y^2 + z^2 <= 1, {x, -1, 1}, {y, -1, 1}, {z, -1, 1}]")
        .expect("RegionPlot3D is a scene");
    assert!(region.contains("\"box\":[1,1,1]"), "{region}");
    let list = scene("ListPlot3D[Table[Sin[i/5] Cos[j/5], {i, 0, 10}, {j, 0, 10}]]")
        .expect("ListPlot3D is a scene");
    assert!(face_count(&list) > 0, "{list}");
    assert!(list.contains("\"box\":[1,1,0.4]"), "{list}");
}

#[test]
fn a_primitive_graphics_is_not_a_scene() {
    assert!(scene("Graphics3D[{Sphere[], Cuboid[]}]").is_none());
    assert!(scene("VectorPlot3D[{y, -x, 0}, {x, -2, 2}, {y, -2, 2}, {z, -2, 2}]").is_none());
}

#[test]
fn the_evaluation_path_uses_the_option_policy() {
    use crate::eval::evaluate_all;
    woxi::clear_state();
    let scene = evaluate_all("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]");
    assert!(scene.contains("\"plot3d\""), "{scene}");
    assert!(!scene.contains("\"svg\""), "{scene}");

    woxi::clear_state();
    let still = evaluate_all("Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, Filling -> Bottom]");
    assert!(still.contains("\"svg\""), "{still}");
    assert!(!still.contains("\"plot3d\""), "{still}");
}

#[test]
fn a_2d_graphics_is_not_a_3d_scene() {
    assert!(scene("Plot[Sin[x], {x, 0, 1}]").is_none());
}

#[test]
fn the_scene_after_show_is_not_extracted_from_an_unrelated_graphic() {
    let output = woxi::interpret_with_stdout("Graphics3D[{Sphere[]}]").ok();
    assert!(output.is_some());
    let Some(Expr::Graphics { ref structure, .. }) = woxi::get_last_output() else {
        return;
    };
    assert!(structure.is_some());
}
