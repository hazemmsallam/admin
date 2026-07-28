package com.eventticketing.admin.client.dto;

/** Saves the admin's current selection as a reusable preset. The name must be unique. */
public record CreateLayoutPresetRequest(
        String name,
        String description,
        Integer width,
        Integer height,
        PresetMembers members
) {
}
