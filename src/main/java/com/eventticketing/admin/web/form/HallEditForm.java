package com.eventticketing.admin.web.form;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class HallEditForm {

    @NotBlank
    private String name;

    private String address;
}
