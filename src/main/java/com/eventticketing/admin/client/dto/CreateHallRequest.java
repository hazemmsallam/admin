package com.eventticketing.admin.client.dto;

public record CreateHallRequest(
        String name,
        String address,
        boolean seated,
        Integer numRows,
        Integer numColumns,
        String numberingScheme,
        Integer capacity
) {
}
