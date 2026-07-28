package com.eventticketing.admin.client.dto;

import java.util.List;

/**
 * Contents of a layout preset: the sections, seats and tables that were selected when it was saved.
 * Coordinates are relative to the preset's bounding box, so it can be stamped anywhere.
 */
public record PresetMembers(
        List<PresetSectionItem> sections,
        List<PresetSeatItem> seats,
        List<PresetTableItem> tables
) {
}
