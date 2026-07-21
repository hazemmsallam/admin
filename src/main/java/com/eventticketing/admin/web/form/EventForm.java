package com.eventticketing.admin.web.form;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

@Data
public class EventForm {

    @NotBlank
    private String name;

    private String description;

    private String category;

    /** Value from an HTML datetime-local input, e.g. "2026-08-01T19:00". Treated as UTC. */
    @NotBlank
    private String startAt;

    @NotBlank
    private String endAt;

    @NotNull
    private Long organizerId;

    @NotNull
    private Long hallId;

    @NotNull
    @Min(1)
    private Integer maxCapacity;
}
